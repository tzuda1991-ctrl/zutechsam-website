import {open, mkdir, rename, rm, stat, statfs, readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';

export const directory = process.env.UPLOAD_DIR || '/data/uploads';
const mib = 1024 ** 2;
const configured = Number(process.env.APK_MAX_MB || 1024);
export const apkMB = Number.isSafeInteger(configured) && configured > 0 && configured <= 16384 ? configured : 1024;
export const chunkSize = 4 * mib;
const pending = path.join(directory, '.incoming');
const busy = new Set();
const fail = (status, message) => Object.assign(new Error(message), {status});
const mediaId = /^[a-f0-9]{40}\.(apk|aab|pdf|zip|png|jpg|jpeg|webp)$/;
const limit = ext => (['.apk','.zip','.aab','.pdf'].includes(ext) ? apkMB : 100) * mib;

export async function startUpload(ext, total) {
  if (!['.apk','.zip','.aab','.pdf','.png','.jpg','.jpeg','.webp'].includes(ext)) throw fail(400,'Unsupported file type');
  if (!Number.isSafeInteger(total) || total < 16 || total > limit(ext)) throw fail(413,'File exceeds the allowed size or is empty');
  await mkdir(pending, {recursive:true});
  const fs=await statfs(pending);
  if(total>fs.bavail*fs.bsize)throw fail(507,'Insufficient storage on the admin volume. Use an external download link or free space.');
  const id = randomBytes(20).toString('hex') + ext;
  const file = await open(path.join(pending,id), 'wx', 0o600);
  await file.close();
  // Total is part of the staged filename so retries survive a process restart.
  await rename(path.join(pending,id), path.join(pending,id + '-' + total));
  return {id, chunkSize};
}

export async function writePart(req, id, total, offset, maxPart = chunkSize) {
  if (!mediaId.test(id) || !Number.isSafeInteger(total) || total > limit(path.extname(id)) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset >= total) throw fail(400,'Invalid upload range');
  if (busy.has(id)) throw fail(409,'Upload busy');
  busy.add(id);
  const temp = path.join(pending,id + '-' + total);
  let file;
  try {
    try { file = await open(temp, 'r+'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const final = await stat(path.join(directory,id)).catch(()=>null);
      if (final?.size === total) return {offset:total,url:'/media/'+id};
      throw fail(404,'Upload expired. Select the file again.');
    }
    const {size} = await file.stat();
    if (size !== offset) return {offset:size};
    let pos = offset;
    try {
      for await (const data of req) {
        if (pos + data.length > Math.min(total,offset + maxPart)) throw fail(413,'Upload part too large');
        let i = 0;
        while (i < data.length) {
          const {bytesWritten} = await file.write(data,i,data.length-i,pos);
          i += bytesWritten;
          pos += bytesWritten;
        }
      }
      if (pos === offset) throw fail(400,'Empty upload part');
      if (pos < total) return {offset:pos};
      const buffer = Buffer.alloc(12);
      await file.read(buffer,0,12,0);
      const hex = buffer.toString('hex');
      const valid = {'.pdf':hex.startsWith('255044462d'),'.aab':hex.startsWith('504b0304'),'.zip':hex.startsWith('504b0304')||hex.startsWith('504b0506'),'.apk':hex.startsWith('504b0304'),'.png':hex.startsWith('89504e470d0a1a0a'),'.jpg':hex.startsWith('ffd8ff'),'.jpeg':hex.startsWith('ffd8ff'),'.webp':hex.startsWith('52494646') && hex.endsWith('57454250')};
      if (!valid[path.extname(id)]) {await rm(temp);throw fail(400,'File signature does not match its type');}
      await rename(temp,path.join(directory,id));
      return {offset:pos,url:'/media/'+id};
    } catch(error) {await file.truncate(offset);if(error.code==='ENOSPC')throw fail(507,'Admin storage is full. Use an external download link.');throw error;}
  } finally {try {await file?.close();} finally {busy.delete(id);}}
}

export async function cleanStaging() {
  const names = await readdir(pending).catch(()=>[]);
  for (const name of names) {
    if (busy.has(name.split('-')[0])) continue;
    const file = path.join(pending,name);
    const info = await stat(file).catch(()=>null);
    if (info && Date.now()-info.mtimeMs > 86400000) await rm(file,{force:true});
  }
}

export async function storageSpace() {
  await mkdir(directory,{recursive:true});
  const fs=await statfs(directory);
  return {free:fs.bavail*fs.bsize,total:fs.blocks*fs.bsize};
}

export async function uploadPosition(id,total) {
  if(!mediaId.test(id)||!Number.isSafeInteger(total)||total<=0)throw fail(400,'Invalid upload');
  const finished=await stat(path.join(directory,id)).catch(()=>null);
  if(finished?.size===total)return {offset:total,url:'/media/'+id};
  const partial=await stat(path.join(pending,id+'-'+total)).catch(()=>null);
  if(!partial)throw fail(404,'Upload expired');
  return {offset:partial.size};
}

export async function storedFiles() {
  const space=await storageSpace();
  const files=[];
  for(const name of await readdir(directory)){
    if(!mediaId.test(name))continue;
    const info=await stat(path.join(directory,name));
    files.push({name,size:info.size,modified:info.mtime});
  }
  return {...space,files:files.sort((a,b)=>b.modified-a.modified)};
}
