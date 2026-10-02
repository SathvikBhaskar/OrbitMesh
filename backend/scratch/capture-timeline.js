const { CDP, getWsUrl } = require('./cdp-client');

async function main() {
  const ws = await getWsUrl();
  const cdp = new CDP(ws);
  await cdp.connect();
  console.log('Navigating to Reservation Timeline...');
  await cdp.eval(`
    (() => {
      const items = Array.from(document.querySelectorAll('button, div, a, span'));
      const target = items.find(e => e.textContent && e.textContent.trim() === 'Reservation Timeline');
      if (target) target.click();
    })()
  `);
  console.log('Waiting 3.5s for Gantt timeline to render...');
  await new Promise(r => setTimeout(r, 3500));
  await cdp.screenshot('c:/Desktop/CODES/OrbitMesh/backend/scratch/timeline_verified.png');
  console.log('Screenshot saved to backend/scratch/timeline_verified.png');
  cdp.close();
}

main().catch(console.error);
