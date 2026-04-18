export const MARKETPLACE_SCREENING_RULES = {
  minUsefulPrice: 2500,
  maxUsefulPrice: 25000,
  minComparablePrice: 6000,
  maxComparablePrice: 20000,
  maxUsefulMiles: 130000,
  minUsefulYear: 2014,
  excludedFuelTypes: ["electric", "hybrid"],
};

export const MARKETPLACE_INVALID_LISTING_TERMS = [
  "salvage",
  "salvaje",
  "rebuilt",
  "rebuild",
  "reconstructed",
  "total loss",
  "turbo",
  "recommended down payment",
  "down payment",
  "monthly payment",
  "monthly payments",
  "weekly payment",
  "weekly payments",
  "bi-weekly",
  "bi weekly",
  "per week",
  "per month",
  "finance available",
  "owner finance",
  "financing",
  "enganche",
  "credito",
  "crédito",
  "i'm listing this car for my neighbor",
  "im listing this car for my neighbor",
];

export const MARKETPLACE_VEHICLE_CATALOG = [
  {
    make: "Acura",
    aliases: ["acura"],
    models: ["ILX", "Integra", "MDX", "RDX", "TLX"],
  },
  {
    make: "Audi",
    aliases: ["audi"],
    models: ["A3", "A4", "A5", "Q3", "Q5", "Q7"],
  },
  {
    make: "Buick",
    aliases: ["buick"],
    models: ["Encore", "Envision", "LaCrosse", "Regal", "Verano"],
  },
  {
    make: "Honda",
    aliases: ["honda"],
    models: ["Accord", "Civic", "CR-V", "Fit", "Odyssey", "Pilot", "Insight", "HRV", "HR-V"],
  },
  {
    make: "Hyundai",
    aliases: ["hyundai"],
    models: ["Accent", "Elantra", "Kona", "Santa Fe", "Sonata", "Tucson", "Equus", "Veloster"],
  },
  {
    make: "Kia",
    aliases: ["kia"],
    models: [
      { name: "Forte", aliases: ["Forte", "Forte5"] },
      "K5",
      "Optima",
      "Rio",
      "Soul",
      "Sportage",
      "Telluride",
      "Sorento",
    ],
  },
  {
    make: "Lexus",
    aliases: ["lexus"],
    models: ["CT", "ES", "GX", "HS", "IS", "LS", "LX", "NX", "RC", "RX", "UX"],
  },
  {
    make: "Ford",
    aliases: ["ford"],
    models: ["Ecosport", "Escape", "Explorer", "F-150", "Focus", "Fusion", "Mustang", "Edge", "Taurus"],
  },
  {
    make: "Toyota",
    aliases: ["toyota"],
    models: ["Camry", "Corolla", "Highlander", "Prius", "RAV4", "Yaris", "C-HR"],
  },
  {
    make: "Chevrolet",
    aliases: ["chevrolet", "chevy"],
    models: ["Bolt", "Cruze", "Equinox", "Express", "Malibu", "Silverado", "Sonic", { name: "Trax", aliases: ["Trax", "Traxx"] }],
  },
  {
    make: "Dodge",
    aliases: ["dodge"],
    models: ["Avenger", "Caliber", "Challenger", "Charger", "Caravan", "Dart", "Durango", "Grand Caravan", "Journey"],
  },
  {
    make: "Fiat",
    aliases: ["fiat"],
    models: ["500", "500L", "500X", "Spider"],
  },
  {
    make: "Nissan",
    aliases: ["nissan"],
    models: [
      "Altima",
      { name: "Cube", aliases: ["Cube", "Cube S", "Cube SL"] },
      "Leaf",
      "Maxima",
      "Murano",
      "Rogue",
      "Sentra",
      "Versa",
      "Kicks",
      "Juke",
    ],
  },
  {
    make: "Subaru",
    aliases: ["subaru"],
    models: ["Ascent", "Crosstrek", "Forester", "Impreza", "Legacy", "Outback"],
  },
  {
    make: "Mazda",
    aliases: ["mazda"],
    models: ["3", "6", "CX-5", "Mazda3", "Mazda2", "Mazda6", "Miata"],
  },
    {
    make: "Scion",
    aliases: ["scion"],
    models: ["xA", "iA", "iM", "tC", "xB", "xD"],
  },
];

export const TEXAS_CITY_DISTANCE_FROM_BUDA = {
  austin: 16,
  bastrop: 33,
  belton: 76,
  buda: 0,
  bulverde: 54,
  "canyon lake": 43,
  "cedar park": 34,
  "cedar creek": 17,
  dale: 18,
  "del valle": 18,
  "dripping springs": 20,
  elgin: 31,
  converse: 54,
  georgetown: 42,
  gonzales: 56,
  hutto: 34,
  jonestown: 42,
  jarrell: 54,
  kyle: 8,
  "la vernia": 57,
  leander: 38,
  "live oak": 49,
  lockhart: 18,
  luling: 31,
  manchaca: 7,
  manor: 24,
  "new braunfels": 38,
  pflugerville: 30,
  "round rock": 28,
  rosanky: 26,
  schertz: 45,
  seguin: 43,
  "san antonio": 58,
  "san marcos": 18,
  spicewood: 46,
  temple: 73,
  "universal city": 50,
  windcrest: 53,
  wimberley: 18,
};

function normalizeCatalogText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasWholePhrase(haystack, phrase) {
  const normalizedHaystack = ` ${normalizeCatalogText(haystack)} `;
  const normalizedPhrase = ` ${normalizeCatalogText(phrase)} `;
  return normalizedHaystack.includes(normalizedPhrase);
}

export function inferVehicleFromDescription(description) {
  const text = String(description || "");
  if (!text.trim()) return { make: "", model: "" };

  let matchedEntry = null;
  for (const entry of MARKETPLACE_VEHICLE_CATALOG) {
    const aliases = entry.aliases?.length ? entry.aliases : [entry.make];
    if (aliases.some((alias) => hasWholePhrase(text, alias))) {
      matchedEntry = entry;
      break;
    }
  }

  if (!matchedEntry) {
    return { make: "", model: "" };
  }

  const matchedModelEntry =
    [...matchedEntry.models]
      .sort((a, b) => {
        const aName = typeof a === "string" ? a : a?.name || "";
        const bName = typeof b === "string" ? b : b?.name || "";
        return bName.length - aName.length;
      })
      .find((model) => {
        if (typeof model === "string") return hasWholePhrase(text, model);
        const aliases = Array.isArray(model?.aliases) && model.aliases.length
          ? model.aliases
          : [model?.name].filter(Boolean);
        return aliases.some((alias) => hasWholePhrase(text, alias));
      }) || "";

  const matchedModel =
    typeof matchedModelEntry === "string"
      ? matchedModelEntry
      : matchedModelEntry?.name || "";

  return {
    make: matchedEntry.make,
    model: matchedModel,
  };
}

export function estimateTexasCityDistanceFromBuda(cityStateText) {
  const city = String(cityStateText || "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();

  if (!city) return null;
  return TEXAS_CITY_DISTANCE_FROM_BUDA[city] ?? null;
}

export function inferTexasCityFromDescription(description) {
  const text = String(description || "");
  if (!text.trim()) return "";

  const matchedCity = Object.keys(TEXAS_CITY_DISTANCE_FROM_BUDA)
    .sort((a, b) => b.length - a.length)
    .find((city) => hasWholePhrase(text, city));

  if (!matchedCity) return "";

  const cityLabel = matchedCity
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return `${cityLabel}, TX`;
}
