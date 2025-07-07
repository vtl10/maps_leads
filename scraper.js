const puppeteer = require('puppeteer');
const axios = require('axios');

const N8N_WEBHOOK = 'https://vtech2.app.n8n.cloud/webhook/49781dbc-8432-4c74-9aa7-794600d89438';

const WAIT_AFTER_LOAD = 5000;
const WAIT_AFTER_CLICK = 3500;
const WAIT_AFTER_CLOSE = 5500; // extra wait after close
const WAIT_AFTER_RELOAD = 6000;
const BATCH_SIZE = 30;
const MAX_RELOADS_PER_BIZ = 3;

const MAX_SCROLLS = 5;
const MAX_SHOW_MORE_CLICKS = 10;
const MAX_BUSINESSES = 50;

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function sendBatch(batch) {
  if (!batch.length) return;
  try {
    await axios.post(N8N_WEBHOOK, { results: batch });
    console.log(`Batch of ${batch.length} sent to n8n.`);
  } catch (e) {
    console.warn('Error sending batch to n8n:', e.message);
  }
}

async function scrapeGoogleMaps(searchQuery) {
  let allResults = [];
  let batch = [];
  let completedBusinesses = new Set();

  const GOOGLE_MAPS_URL = 'https://www.google.com/maps/search/' + encodeURIComponent(searchQuery);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null,
  });
  const page = await browser.newPage();

  console.log(`[INFO] Navigating to search URL: ${GOOGLE_MAPS_URL}`);
  await page.goto(GOOGLE_MAPS_URL, { waitUntil: 'networkidle2' });
  await sleep(WAIT_AFTER_LOAD);

  // Detect sidebar selector
  const sidebarSelectorCandidates = [
    '.m6QErb.DxyBCb.kA9K',
    '[role="region"]',
    '.section-scrollbox',
  ];

  let sidebarSelector = null;
  for (const sel of sidebarSelectorCandidates) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      sidebarSelector = sel;
      console.log(`[INFO] Using sidebar selector: ${sel}`);
      await page.focus(sel);
      break;
    } catch (e) {
      // Try next selector
    }
  }

  if (!sidebarSelector) {
    console.error('[ERROR] Could not find sidebar selector, aborting.');
    await browser.close();
    throw new Error('Sidebar selector not found');
  }

  // Scroll sidebar with PageDown keys
  for (let i = 0; i < MAX_SCROLLS; i++) {
    await page.keyboard.press('PageDown');
    await sleep(3500);
    console.log(`[INFO] Initial scroll #${i + 1}`);
  }

  // Click “Show more” buttons if present
  const showMoreSelector = 'button[jsaction="pane.paginationSection.nextPage"]';
  for (let i = 0; i < MAX_SHOW_MORE_CLICKS; i++) {
    const showMoreButton = await page.$(showMoreSelector);
    if (!showMoreButton) {
      console.log('[INFO] No more "Show more" button found, stopping.');
      break;
    }
    console.log(`[INFO] Clicking "Show more" button #${i + 1}`);
    await showMoreButton.click();
    await sleep(5000);
  }

  // Extract business names
  let businessNames = await page.$$eval('.Nv2PK', cards =>
    cards.map(card => card.querySelector('a.hfpxzc')?.innerText ||
                      card.querySelector('.qBF1Pd')?.innerText ||
                      card.innerText.split('\n')[0])
  );
  console.log(`Total businesses collected: ${businessNames.length}`);

  for (let i = 0; i < businessNames.length && allResults.length < MAX_BUSINESSES; i++) {
    let name = businessNames[i];
    if (completedBusinesses.has(name)) continue;
    let attempt = 0, found = false, reloads = 0;

    while (attempt < 3 && !found) {
      try {
        await page.evaluate(() => {
          const container = document.querySelector('.m6QErb.DxyBCb.kA9K');
          if (container) container.scrollTop = container.scrollHeight;
        });
        await sleep(1500);

        let cardIndex = await page.evaluate(targetName => {
          const cards = Array.from(document.querySelectorAll('.Nv2PK'));
          for (let i = 0; i < cards.length; i++) {
            const n = cards[i].querySelector('a.hfpxzc')?.innerText ||
                      cards[i].querySelector('.qBF1Pd')?.innerText ||
                      cards[i].innerText.split('\n')[0];
            if (n && n.trim().toLowerCase().includes(targetName.trim().toLowerCase())) {
              cards[i].scrollIntoView({ behavior: 'auto', block: 'center' });
              return i;
            }
          }
          return -1;
        }, name);

        if (cardIndex === -1) {
          console.warn(`[WARN] Could not find card for "${name}"`);
          if (++reloads > MAX_RELOADS_PER_BIZ) {
            console.warn(`[WARN] Could not find "${name}" after ${MAX_RELOADS_PER_BIZ} reloads. Skipping.`);
            found = true;
            continue;
          }
          console.warn(`[INFO] Reloading search (${reloads}/${MAX_RELOADS_PER_BIZ})...`);
          await page.goto(GOOGLE_MAPS_URL, { waitUntil: 'networkidle2' });
          await sleep(WAIT_AFTER_RELOAD);
          continue;
        }

        let cards = await page.$$('.Nv2PK');
        await sleep(1200);

        await cards[cardIndex].click();
        await sleep(WAIT_AFTER_CLICK);

        let detail = {};
        detail.name = await page.$eval('h1.DUwDvf', el => el.innerText).catch(() => null);
        detail.address = await page.$eval('[data-item-id="address"] .Io6YTe', el => el.innerText).catch(() => null);
        detail.website = await page.$eval('a[aria-label^="Website:"]', el => el.href).catch(() => null);
        console.log(detail);

        allResults.push(detail);
        batch.push(detail);
        completedBusinesses.add(name);

        if (batch.length >= BATCH_SIZE) {
          await sendBatch(batch);
          batch = [];
        }

        // Close detail view with Back button or Escape key
        const backBtn = await page.$('button[aria-label="Back"]');
        if (backBtn) {
          await backBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
        await sleep(WAIT_AFTER_CLOSE);

        // Check if sidebar still present, reload if vanished
        let stillThere = await page.$('.Nv2PK');
        if (!stillThere) {
          console.log('[INFO] Card list vanished after close, reloading search...');
          await page.goto(GOOGLE_MAPS_URL, { waitUntil: 'networkidle2' });
          await sleep(WAIT_AFTER_RELOAD);
        }

        found = true;
      } catch (err) {
        attempt++;
        console.error('[ERROR]', err.message || err);
        if (attempt < 3) {
          console.log('Retrying...');
          await sleep(3000);
        } else {
          console.log('Giving up on this business, moving to next.');
        }
      }
    }
  }

  if (batch.length > 0) {
    await sendBatch(batch);
  }

  console.log('All results collected:', allResults.length);
  await browser.close();

  return allResults;
}

// Export the function for external use
module.exports = { scrapeGoogleMaps };
