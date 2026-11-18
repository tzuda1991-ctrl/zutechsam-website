(() => {
  document.querySelectorAll('[data-compare]').forEach((select) => {
    const show = () => {
      const source = document.getElementById('release-' + select.value);
      const target = select.nextElementSibling;
      target.replaceChildren();
      if (!source) return;
      for (const el of source.querySelectorAll('.version-head, small, p, dl')) {
        target.append(el.cloneNode(true));
      }
    };
    select.onchange = show;
    show();
  });

  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.copy-sha');
    if (!copyBtn) return;
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copy || '');
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = prev), 1500);
    } catch {}
  });

  const link = document.getElementById('campaignLink');
  if (link) {
    link.value = location.origin + location.pathname.replace(/\/$/, '') + '/youtube';
    document.getElementById('copyCampaign').onclick = async (e) => {
      try {
        await navigator.clipboard.writeText(link.value);
        e.target.textContent = 'Copied';
      } catch {
        link.select();
      }
    };
  }

  // Screenshot Lightbox
  const galleryItems = [...document.querySelectorAll('[data-lightbox]')];
  const lightbox = document.getElementById('lightbox');
  if (lightbox && galleryItems.length) {
    const img = document.getElementById('lightboxImg');
    const count = document.getElementById('lightboxCount');
    let idx = 0;
    const showIndex = (next) => {
      idx = (next + galleryItems.length) % galleryItems.length;
      img.src = galleryItems[idx].dataset.lightbox;
      count.textContent = `${idx + 1} / ${galleryItems.length}`;
    };
    galleryItems.forEach((el, i) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        showIndex(i);
        lightbox.showModal();
      });
    });
    document.getElementById('lightboxPrev').onclick = () => showIndex(idx - 1);
    document.getElementById('lightboxNext').onclick = () => showIndex(idx + 1);
    document.getElementById('lightboxClose').onclick = () => lightbox.close();
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) lightbox.close();
    });
  }

  async function screenshot(file) {
    const img = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 850 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.75, 0.5, 0.3, 0.15]) {
        const url = canvas.toDataURL('image/jpeg', quality);
        if (url.length <= 85000) return url;
      }
      throw Error('Crop this screenshot and try again.');
    } finally {
      img.close();
    }
  }

  const basePath = location.pathname.replace(/\/$/, '');

  const form = document.getElementById('reportForm');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const status = form.querySelector('[role=status]');
      const button = form.querySelector('button');
      button.disabled = true;
      status.textContent = 'Sending…';
      try {
        const fields = form.elements;
        const file = fields.image.files[0];
        const payload = { release: fields.release.value, message: fields.message.value };
        if (file) payload.screenshot = await screenshot(file);
        const response = await fetch(basePath + '/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not send report.');
        form.reset();
        status.textContent = `Report #${data.id} sent to the studio.`;
      } catch (err) {
        status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
  }

  const reviewForm = document.getElementById('reviewForm');
  if (reviewForm) {
    reviewForm.onsubmit = async (e) => {
      e.preventDefault();
      const status = reviewForm.querySelector('[role=status]');
      const button = reviewForm.querySelector('button');
      button.disabled = true;
      status.textContent = 'Submitting…';
      try {
        const fields = reviewForm.elements;
        const response = await fetch(basePath + '/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            author_name: fields.author_name.value,
            rating: Number(fields.rating.value),
            comment: fields.comment.value,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not submit review.');
        reviewForm.reset();
        status.textContent = 'Thank you! Your review has been queued for studio approval.';
      } catch (err) {
        status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
  }

  const betaForm = document.getElementById('betaForm');
  if (betaForm) {
    betaForm.onsubmit = async (e) => {
      e.preventDefault();
      const status = betaForm.querySelector('[role=status]');
      const button = betaForm.querySelector('button');
      button.disabled = true;
      status.textContent = 'Joining…';
      try {
        const fields = betaForm.elements;
        const response = await fetch(basePath + '/beta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: fields.email.value,
            device: fields.device.value,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not join beta list.');
        betaForm.reset();
        status.textContent = 'You are on the beta testing list for upcoming releases.';
      } catch (err) {
        status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
  }

  // Public /releases changelog filters
  const channelGroup = document.getElementById('channelFilter');
  const categorySelect = document.getElementById('changelogCategory');
  const changelogList = document.getElementById('changelogList');
  if (channelGroup && categorySelect && changelogList) {
    let channel = 'All';
    const filterChangelog = () => {
      const cat = categorySelect.value;
      let shown = 0;
      changelogList.querySelectorAll('.changelog-entry').forEach((el) => {
        const matchChannel = channel === 'All' || el.dataset.channel === channel;
        const matchCat = cat === 'All' || el.dataset.category === cat;
        el.hidden = !(matchChannel && matchCat);
        if (!el.hidden) shown++;
      });
      let empty = changelogList.querySelector('.changelog-empty');
      if (!shown) {
        if (!empty) {
          empty = document.createElement('p');
          empty.className = 'empty changelog-empty';
          empty.textContent = 'No releases match the selected channel and category.';
          changelogList.append(empty);
        }
      } else if (empty) {
        empty.remove();
      }
    };
    channelGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      channel = btn.dataset.val;
      channelGroup.querySelectorAll('button').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      filterChangelog();
    });
    categorySelect.addEventListener('change', filterChangelog);
  }
})();
