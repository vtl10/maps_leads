const express = require('express');
const { scrapeGoogleMaps } = require('./scraper');

const app = express();
app.use(express.json());

app.post('/scrape', async (req, res) => {
  try {
    const { searchQuery } = req.body;
    if (!searchQuery) {
      return res.status(400).json({ error: 'searchQuery is required' });
    }
    const results = await scrapeGoogleMaps(searchQuery);
    res.json({ success: true, results });
  } catch (err) {
    console.error('Error in /scrape:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
