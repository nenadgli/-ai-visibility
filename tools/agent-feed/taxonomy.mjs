// Interne Magento kategorije (poslednji deo putanje product_type) → Google product taxonomy ID.
// Izvor ID-jeva: https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt
// Ključ je naziv kategorije malim slovima; prvi deo putanje (Žene/Muškarci/Deca) određuje age_group.
export const LEAF_TO_GOOGLE = {
  // odeća
  "majice": 212,            // Clothing > Shirts & Tops
  "košulje": 212,
  "dukserice": 212,
  "džemperi": 212,
  "haljine": 2271,          // Clothing > Dresses
  "pantalone": 204,         // Clothing > Pants
  "farmerke": 204,
  "bermude": 207,           // Clothing > Shorts
  "šortsevi": 207,
  "suknje": 1581,           // Clothing > Skirts
  "jakne i kaputi": 5598,   // Clothing > Outerwear > Coats & Jackets
  "sakoi": 5598,
  "pončo": 203,             // Clothing > Outerwear
  "kupaći kostimi": 211,    // Clothing > Swimwear
  "veš": 213,               // Clothing > Underwear & Socks
  "pidžame": 2580,          // Clothing > Sleepwear & Loungewear > Pajamas
  "kombinezoni": 5250,      // Clothing > One-Pieces > Jumpsuits & Rompers
  "odelo": 1594,            // Clothing > Suits
  "set": 7313,              // Clothing > Outfit Sets
  "odeća": 1604,            // Clothing (dečija odeća bez podkategorije)
  // obuća: Google nema podkategorije za cipele
  "obuća": 187, "patike": 187, "cipele": 187, "čizme": 187, "sandale": 187, "papuče": 187,
  "japanke": 187, "mokasine": 187, "baletanke": 187, "espadrile": 187,
  // torbe
  "male torbe": 3032,       // Handbags, Wallets & Cases > Handbags
  "velike torbe": 3032,
  "večernje torbe": 3032,
  "torbe za plažu": 3032,
  "rančevi": 100,           // Luggage & Bags > Backpacks
  "putne torbe": 103,       // Luggage & Bags > Duffel Bags
  "laptop torbe": 101,      // Luggage & Bags > Briefcases
  // aksesoari
  "kaiševi": 169,           // Clothing Accessories > Belts
  "kape i rukavice": 173,   // Clothing Accessories > Hats
  "kačketi": 173,
  "naocare": 178,           // Clothing Accessories > Sunglasses
  "novčanici": 2668,        // Handbags, Wallets & Cases > Wallets & Money Clips
  "čarape": 209,            // Underwear & Socks > Socks
  "šalovi i marame": 177,   // Clothing Accessories > Scarves & Shawls
  "neseseri": 108,          // Luggage & Bags > Cosmetic & Toiletry Bags
  "maske": 167,             // Clothing Accessories
  "ostalo": 167,
  "aksesoari": 167,
  // kozmetika
  "make-up": 477,           // Cosmetics > Makeup
  "skin care": 567,         // Cosmetics > Skin Care
  "fragrance": 479,         // Cosmetics > Perfume & Cologne
  "accessories": 2619,      // Cosmetics > Cosmetic Tools
};

export const TOP_TO_AGE_GROUP = { "deca": "kids", "žene": "adult", "muškarci": "adult" };
