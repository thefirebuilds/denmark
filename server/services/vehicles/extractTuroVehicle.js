function decode(value) {
  let text = String(value || '').replace(/&amp;|&#38;|&#x26;/gi, '&');
  for (let i = 0; i < 2; i++) {
    try { const next = decodeURIComponent(text); if (next === text) break; text = next; }
    catch { break; }
  }
  return text;
}

function extractTuroVehicle(html) {
  const text = decode(html);
  const listing = value => {
    const match = value.match(/https?:\/\/(?:www\.)?turo\.com\/(?:[a-z]{2}\/)?[a-z]{2}\/[a-z-]+-rental\/[^\s"'<>?&#]+\/(\d+)(?=[/?&#\s"'<>]|$)/i);
    return match ? { url: match[0], id: match[1] } : null;
  };
  // The link wrapping the vehicle image is stronger evidence than unrelated
  // promotional links elsewhere in the email.
  const imageLinks = [...text.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)]
    .filter(match => /<img\b/i.test(match[3])).map(match => listing(match[2])).filter(Boolean);
  const unique = values => {
    const byId = new Map(values.map(value => [value.id, value]));
    return byId.size === 1 ? [...byId.values()][0] : null;
  };
  if (imageLinks.length) return unique(imageLinks) || { url: null, id: null };
  const images = [...text.matchAll(/<img\b[^>]*>/gi)];
  const imageIds = [];
  for (const [tag] of images) {
    const attribute = tag.match(/\bdata-(?:turo-)?vehicle-id\s*=\s*["'](\d+)["']/i);
    if (attribute) imageIds.push({ url: null, id: attribute[1] });
    for (const url of tag.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const value = url[0];
      if (!/^https?:\/\/(?:[a-z0-9-]+\.)*turo\.com\//i.test(value)) continue;
      const match = value.match(/[?&](?:vehicleId|vehicle_id)=(\d+)(?:[&#]|$)/i)
        || value.match(/\/vehicles?\/(\d+)(?:\/|[?#]|$)/i);
      if (match) imageIds.push({ url: null, id: match[1] });
    }
  }
  if (imageIds.length) return unique(imageIds) || { url: null, id: null };
  const links = [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(match => listing(match[0])).filter(Boolean);
  return unique(links) || { url: null, id: null };
}

module.exports = { extractTuroVehicle };
