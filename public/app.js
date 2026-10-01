(function () {
  const form = document.getElementById('form');
  const btn = document.getElementById('btn');
  const statusMsg = document.getElementById('statusMsg');
  const summaryEl = document.getElementById('summary');
  const cards = document.getElementById('cards');
  const embed = document.getElementById('embed');
  const frame = document.getElementById('reportFrame');

  function card(n, label, kind) {
    const d = document.createElement('div');
    d.className = 'card ' + (kind || '');
    d.innerHTML = '<div class="n"></div><div class="l"></div>';
    d.querySelector('.n').textContent = n;
    d.querySelector('.l').textContent = label;
    return d;
  }

  function bust(href) {
    return href + (href.includes('?') ? '&' : '?') + 't=' + Date.now();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusMsg.textContent = 'Comparing…';
    statusMsg.className = 'status';
    btn.disabled = true;
    summaryEl.classList.add('hidden');
    embed.classList.add('hidden');

    const fd = new FormData();
    fd.append('status', document.getElementById('status').files[0]);
    fd.append('pmta', document.getElementById('pmta').files[0]);
    fd.append('mfg', document.getElementById('mfg').files[0]);

    try {
      const res = await fetch('/api/compare', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Compare failed');

      const s = data.summary;
      cards.innerHTML = '';
      cards.appendChild(card(s.statusCount, 'Status employees'));
      cards.appendChild(card(s.pmtaCount, 'PMTA allocation'));
      cards.appendChild(card(s.mfgCount, 'MFG allocation'));
      cards.appendChild(card(s.pmtaMatched, 'PMTA matched', 'ok'));
      cards.appendChild(card(s.mfgMatched, 'MFG matched', 'ok'));
      cards.appendChild(card(s.totalMismatches, 'Mismatch rows', 'warn'));
      for (const [k, v] of Object.entries(s.categories || {})) {
        if (v) cards.appendChild(card(v, k, 'warn'));
      }

      // Point download links at fresh URLs (cache-bust)
      const d = data.downloads || {};
      const htmlHref = bust(d.reportHtml || '/download/report.html');
      const xlsxHref = bust(d.reportXlsx || '/download/report.xlsx');
      document.getElementById('dlHtml').href = htmlHref;
      document.getElementById('dlXlsx').href = xlsxHref;
      document.getElementById('dlOpenHtml').href = htmlHref;
      document.getElementById('dlMism').href = bust(d.mismatches || '/download/mismatches.csv');
      document.getElementById('dlMatch').href = bust(d.matches || '/download/matches.csv');
      document.getElementById('dlSum').href = bust(d.summary || '/download/summary.json');

      summaryEl.classList.remove('hidden');
      if (data.reportHtml) {
        frame.srcdoc = data.reportHtml;
        embed.classList.remove('hidden');
      }
      statusMsg.textContent = 'Done — use Download HTML / Download Excel below.';
      statusMsg.className = 'status ok';
    } catch (err) {
      statusMsg.textContent = err.message || String(err);
      statusMsg.className = 'status err';
    } finally {
      btn.disabled = false;
    }
  });
})();
