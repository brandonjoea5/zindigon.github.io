(function(){
  const root = document.getElementById('lbRoot');
  if(!root) return;

  const endpoint = root.getAttribute('data-endpoint') || '';
  const loading = document.getElementById('lbLoading');
  const error = document.getElementById('lbError');
  const tableWrap = document.getElementById('lbTable');

  function show(el, yes){ if(el) el.style.display = yes ? '' : 'none'; }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function render(rows){
    const r = Array.isArray(rows) ? rows : [];
    if(!r.length){
      tableWrap.innerHTML = '<div class="notice">No scores yet. Be the first to set a record.</div>';
      return;
    }
    const html = `
      <table class="table" aria-label="Leaderboard">
        <thead>
          <tr>
            <th style="width:72px;">Rank</th>
            <th>Player</th>
            <th style="width:120px;">Best wave</th>
            <th style="width:160px;">Guild</th>
          </tr>
        </thead>
        <tbody>
          ${r.map((it, idx)=>`
            <tr>
              <td><span class="chip" style="font-weight:900;">#${idx+1}</span></td>
              <td>${escapeHtml(it.player || it.name || 'Unknown')}</td>
              <td>${escapeHtml(it.best_wave ?? it.wave ?? it.score ?? '')}</td>
              <td>${escapeHtml(it.guild || it.clan || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    tableWrap.innerHTML = html;
  }

  async function load(){
    try{
      show(loading,true); show(error,false);
      const res = await fetch(endpoint, {headers:{'Accept':'application/json'}});
      if(!res.ok) throw new Error('HTTP '+res.status);
      const data = await res.json();
      // Accept multiple possible payload shapes
      const rows = data.rows || data.data || data.leaderboard || data || [];
      render(rows);
    }catch(e){
      console.error(e);
      show(error,true);
    }finally{
      show(loading,false);
    }
  }

  load();
})();
