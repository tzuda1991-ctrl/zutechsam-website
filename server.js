import http from 'node:http';
import {readFile} from 'node:fs/promises';
const port=Number(process.env.PORT||3000);
const html=await readFile(new URL('./index.html',import.meta.url));
http.createServer((req,res)=>{
 if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true}));}
 if(req.url==='/'||req.url==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
 res.writeHead(404);res.end('Not found');
}).listen(port,'0.0.0.0',()=>console.log('ZUTECHSAM listening on '+port));
