# Lost & Found: everything $20 or less

An online shop for second-hand finds. Shoppers browse by **product, cost or date added** across
**Decor, Tech, Clothes (by season) and Toys**. The owner manages everything from the **Admin side**:
adding items with pictures and prices, changing prices, comparing prices with other stores, and
finding deals from other stores.

## Quick start

Requires [Node.js](https://nodejs.org) 18 or newer. There is nothing to install because there are no dependencies.

```bash
cd lost-and-found
ADMIN_PASSWORD="pick-a-real-password" npm start
# open http://localhost:3000        (shop)
# open http://localhost:3000/admin.html   (admin side)
```

| Setting | What it does | Default |
|---|---|---|
| `PORT` | Port the site runs on | `3000` |
| `ADMIN_PASSWORD` | Password for the admin pages. **Set this before going live.** | `changeme` |
| `SERPAPI_KEY` | Turns on automatic price comparison and deal search (Google Shopping via [SerpApi](https://serpapi.com); there's a free tier). Without it, the admin still gets one-click search links to Amazon, Walmart, Target, eBay and Best Buy. | *(off)* |
| `DATA_DIR` | Folder for `products.json` / `orders.json` | `data/` |

Run the tests with `npm test`.

The original layout sketch from the client is in `docs/client-layout-sketch.jpg`.

## Pages

| Page | File | What it's for |
|---|---|---|
| Home | `public/index.html` + `js/home.js` | Welcome banner, product-type tiles (including clothes by season), featured items, newest items |
| Shop | `public/shop.html` + `js/shop.js` | Browse by product (search, type, season), cost (max price, sort by price) and date added (sort newest/oldest) |
| Item | `public/item.html` + `js/item.js` | One item's picture, price, details and Add to cart |
| Cart | `public/cart.html` + `js/cart.js` | Cart and checkout. Orders are saved for the admin. |
| Legal | `public/legal.html` | Terms of sale, returns, privacy, copyright (a template: fill in the `[BRACKETS]`) |
| Admin | `public/admin.html` + `js/admin.js` | Add/edit/delete items and pictures, inline and bulk **price changes**, **Compare** prices with other stores, CSV import, JSON backup, orders |
| Deals | `public/admin-deals.html` + `js/admin-deals.js` | Admin-only page to **see deals from other stores** |

The menu and footer are written once in `public/js/common.js` (`MENU` and `SITE` at the top) and appear on every page.

## Where to edit things

| I want to change… | Edit |
|---|---|
| Colors, fonts, spacing | `public/css/style.css`, section 1 (`:root`) |
| Menu links | `public/js/common.js` → `MENU` |
| Shop name, contact email, copyright name | `public/js/common.js` → `SITE` (and the email in `legal.html`) |
| Product types or seasons | `server.js` → `STORE.CATEGORIES` / `STORE.SEASONS` (the dropdowns update automatically) |
| The $20 price cap | `server.js` → `STORE.MAX_PRICE` (also update the wording on the pages) |
| Picture size limit | `server.js` → `STORE.MAX_IMAGE_MB` |
| Quick-search buttons on the Deals page | `public/js/admin-deals.js` → `QUICK_SEARCHES` |
| Store deal-page links | `public/admin-deals.html` → "Store deal pages" |
| Legal wording | `public/legal.html` |

Every file starts with a comment that explains what it does, and each section inside is labelled.

## File formats: how items and pictures are saved

All data is plain files, so there's no database to set up.

```
lost-and-found/
├── data/products.json      ← every item for sale (the admin page writes this)
├── data/orders.json        ← orders from checkout (created automatically; not in git)
├── data/product-template.json   ← example of one item, with notes
└── public/
    ├── uploads/            ← pictures uploaded on the admin page (not in git)
    ├── images/             ← site images and sample pictures
    └── templates/products-import-template.csv  ← spreadsheet template for bulk import
```

### 1. Item format (`data/products.json`)

A list of items, one per `{ }` block:

```json
{
  "id": "itm_3f9a1c2b",          // made automatically, must be unique
  "name": "Wool Knit Beanie",
  "price": 6.00,                 // 0.01 – 20.00
  "wasPrice": 8.00,              // set automatically when a price is lowered; shows "was $8.00"
  "priceHistory": [ { "from": 8, "to": 6, "at": "2026-10-05T15:00:00.000Z" } ],
  "category": "Clothes",         // Decor | Tech | Clothes | Toys | Other
  "season": "Winter",            // Clothes only: Spring | Summer | Fall | Winter | All Season
  "description": "Thick knit beanie, one size fits most.",
  "condition": "Like New",       // New | Like New | Good | Fair
  "quantity": 3,                 // goes down when someone orders; 0 = sold out
  "featured": false,             // true = shown on the home page
  "image": "uploads/1728316800000-a1b2c3.jpg",
  "createdAt": "2026-10-05T15:00:00.000Z"   // the "date added" used for sorting
}
```

(The `//` notes are for explanation only. Real JSON can't contain comments.)

### 2. Pictures

* Accepted: **JPG, PNG, WEBP, GIF**, up to 5 MB.
* The admin page shrinks big photos to a maximum of 1200 px before uploading, so pages load fast.
* Saved as `public/uploads/<time>-<random>.<ext>`, and the item's `image` field points to it.
* Deleting an item, or replacing its picture, deletes the old file too.
* Square photos look best, because shop cards crop to a square.

### 3. Bulk import (CSV spreadsheet)

Make a sheet in Excel or Google Sheets with these columns, save it as **CSV**, and use
*Admin → Import items from CSV*. Download the template from the admin page or use
`public/templates/products-import-template.csv`.

```
name,price,category,season,condition,quantity,featured,description
Ceramic Plant Pot,8.00,Decor,,Good,2,no,"Small white pot, 4 inch"
Rain Jacket (Kids L),15.00,Clothes,Spring,Like New,1,yes,"Yellow, hooded"
```

Rows that break a rule (for example a price over $20) are skipped and listed so they can be fixed.
Add pictures afterwards with **Edit**.

### 4. Backups

*Admin → Download backup (JSON)* saves every item in the same format as `products.json`.
To restore, put that file back as `data/products.json`. Back up `public/uploads/` as well.

## Orders and payment

Checkout saves the order (the server re-checks prices and stock, so they can't be tampered with)
and lowers the item quantities. The admin sees orders under **Admin → Orders**, emails the buyer to arrange
payment and pickup or shipping, and sets the status to *paid*, *completed* or *cancelled*. Cancelling puts the items
back in stock.

To take card payments online later, add a checkout provider such as **Stripe Checkout** or **PayPal**
in `server.js` → `POST /api/orders`. Don't store card numbers on this server.

## Going live

Any host that runs Node.js works (Render, Railway, Fly.io, a VPS…). Keep `data/` and `public/uploads/`
on **persistent storage**, because that's where items, orders and pictures live. Set `ADMIN_PASSWORD` (and
optionally `SERPAPI_KEY`) in the host's environment settings, and serve the site over HTTPS so the admin password is protected.
