const { CDP, getWsUrl } = require('./cdp-client');

async function main() {
  const ws = await getWsUrl();
  const cdp = new CDP(ws);
  await cdp.connect();
  console.log('Clicking "Commit Schedule" button...');
  await cdp.eval(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent && b.textContent.includes('Commit Schedule'));
      if (btn) btn.click();
    })()
  `);
  console.log('Waiting 3s for commit to complete and UI to refresh...');
  await new Promise(r => setTimeout(r, 3000));
  await cdp.screenshot('c:/Desktop/CODES/OrbitMesh/backend/scratch/commit_ui_verified.png');
  console.log('Screenshot saved to backend/scratch/commit_ui_verified.png');
  cdp.close();
}

main().catch(console.error);
