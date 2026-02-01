require('dotenv').config();
const { chromium } = require('playwright');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configurations for each platform
const CONFIG = {
    trendyol: {
        url: 'https://www.trendyol.com/sr?wc=103328&fl=en-cok-one-cikanlar', // Example Category: Women's Clothing -> Bestsellers
        selector: '.p-card-wrppr',
        parser: (el) => {
            const link = el.querySelector('a') ? el.querySelector('a').href : null;
            const img = el.querySelector('img') ? el.querySelector('img').src : null;
            const brand = el.querySelector('.prdct-desc-cntnr-ttl') ? el.querySelector('.prdct-desc-cntnr-ttl').innerText : '';
            const name = el.querySelector('.prdct-desc-cntnr-name') ? el.querySelector('.prdct-desc-cntnr-name').innerText : '';
            const title = `${brand} ${name}`.trim();

            // Price Extraction (e.g. "1.200 TL")
            const cleanPrice = (str) => {
                if (!str) return 0;
                return parseFloat(str.replace(/[^0-9,.]/g, '').replace(',', '.')); // Replace comma with dot if needed, depends on currency format usually TL uses comma for decimals or dot for thousands
            };

            const priceRaw = el.querySelector('.prc-box-dscntd') ? el.querySelector('.prc-box-dscntd').innerText : '0';
            const originalPriceRaw = el.querySelector('.prc-box-orgnl') ? el.querySelector('.prc-box-orgnl').innerText : priceRaw;

            // Trendyo specifics: 129,99 TL -> 129.99
            const parseTRPrice = (p) => parseFloat(p.replace(/[^0-9,]/g, '').replace(',', '.'));

            const price = parseTRPrice(priceRaw);
            const originalPrice = parseTRPrice(originalPriceRaw);

            // Calculate Discount
            let discountRate = 0;
            if (originalPrice > price) {
                discountRate = ((originalPrice - price) / originalPrice) * 100;
            }

            return {
                title,
                price,
                original_price: originalPrice,
                discount_rate: Math.round(discountRate),
                image_url: img,
                product_url: link,
                platform: 'trendyol'
            };
        }
    },
    // Add other platforms like Temu here in future...
    temu: {
        url: 'https://www.temu.com/az/channel/lightning-deals.html',
        selector: '.goods-item', // Example selector, needs verification
        parser: (el) => {
            // Placeholder for Temu logic
            return null;
        }
    }
};

async function scrape(platformKey) {
    if (!CONFIG[platformKey]) return { error: 'Platform not supported' };

    const config = CONFIG[platformKey];
    console.log(`Starting scrape for ${platformKey}...`);

    const browser = await chromium.launch({ headless: true }); // Headless: true for VPS
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Random scroll to trigger lazy loading
        await page.evaluate(async () => {
            window.scrollBy(0, window.innerHeight);
        });
        await page.waitForTimeout(3000);

        // Extract Data
        const products = await page.evaluate(({ selector }) => {
            const items = [];
            document.querySelectorAll(selector).forEach(el => {
                // We return the RAW Text/Attributes here because passing functions (parser) to evaluate is hard
                // But simplified: extract basic DOM data and parse in Node
                // To keep it simple in one pass, let's grab specific attributes based on class names known for Trendyol
                // Note: The parser logic above was for Node context, but 'el' is in Browser context.
                // Let's rewrite this to extraction-only in Browser.

                const getTxt = (sel) => el.querySelector(sel) ? el.querySelector(sel).innerText : '';
                const getAttr = (sel, attr) => el.querySelector(sel) ? el.querySelector(sel).getAttribute(attr) : '';

                items.push({
                    title: getTxt('.prdct-desc-cntnr-ttl') + ' ' + getTxt('.prdct-desc-cntnr-name'),
                    priceStr: getTxt('.prc-box-dscntd'),
                    orgPriceStr: getTxt('.prc-box-orgnl'),
                    link: el.querySelector('a') ? el.querySelector('a').href : '',
                    img: el.querySelector('img') ? el.querySelector('img').src : ''
                });
            });
            return items;
        }, { selector: config.selector });

        // Process Data & Filter in Node
        const validProducts = products.map(p => {
            const parseTRPrice = (str) => {
                if (!str) return 0;
                return parseFloat(str.replace(/[^0-9,]/g, '').replace(',', '.'));
            };
            const price = parseTRPrice(p.priceStr);
            let orgPrice = parseTRPrice(p.orgPriceStr);
            if (orgPrice === 0) orgPrice = price;

            let discount = 0;
            if (orgPrice > price && orgPrice > 0) {
                discount = ((orgPrice - price) / orgPrice) * 100;
            }

            return {
                title: p.title.trim(),
                price,
                original_price: orgPrice,
                discount_rate: Math.round(discount),
                image_url: p.img,
                product_url: p.link,
                platform: platformKey,
                external_id: p.link.split('?')[0] // Use URL as unique ID roughly
            };
        }).filter(p => p.discount_rate >= 40 && p.price > 0 && p.title.length > 5);

        console.log(`Found ${products.length} items, ${validProducts.length} matched >40% discount.`);

        // Save to Supabase
        const savedItems = [];
        for (const prod of validProducts) {
            const { data, error } = await supabase
                .schema('bot_scraper')
                .from('products')
                .upsert(prod, { onConflict: 'platform, external_id', ignoreDuplicates: true }) // upsert or insert?
                .select();

            if (!error && data) savedItems.push(data[0]);
            else if (error) console.error('Supabase Error:', error.message);
        }

        return {
            status: 'success',
            total_found: products.length,
            filtered_count: validProducts.length,
            saved_count: savedItems.length,
            data: validProducts.slice(0, 50)
        };

    } catch (e) {
        console.error(e);
        return { error: e.message };
    } finally {
        await browser.close();
    }
}

app.get('/scrape/:platform', async (req, res) => {
    const result = await scrape(req.params.platform);
    res.json(result);
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
});