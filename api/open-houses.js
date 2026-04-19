// /api/open-houses.js — Vercel Serverless Function
// Scrapes Zillow for Miami-Dade open houses under $1M
// Applies Primesant ring/ZIP priority logic

const RINGS = {
  '33182':1,'33178':1,'33166':1,'33122':1,'33126':1,'33174':1,
  '33192':2,'33164':2,'33165':2,'33175':2,'33144':2,'33134':2,'33010':2,'33012':2,
  '33194':3,'33185':3,'33183':3,'33173':3,'33155':3,'33143':3,'33125':3,'33135':3,'33142':3,'33147':3,'33013':3,'33014':3,'33018':3,
  '33193':4,'33186':4,'33176':4,'33156':4,'33146':4,'33145':4,'33130':4,'33127':4,'33136':4,'33128':4,'33150':4,'33054':4,'33055':4,'33015':4
};

const BASE_LAT = 25.7748;
const BASE_LNG = -80.3626;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getNextWeekend() {
  const now = new Date();
  const day = now.getDay();
  let daysUntilSat = (6 - day) % 7;
  if (daysUntilSat === 0 && now.getHours() >= 18) daysUntilSat = 7;
  if (daysUntilSat === 0) daysUntilSat = 0;
  if (day === 0) daysUntilSat = 6;

  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);

  const fmt = d => d.toISOString().split('T')[0];
  return { saturday: fmt(sat), sunday: fmt(sun) };
}

async function fetchZillowPage(page = 1) {
  const searchQuery = {
    searchQueryState: {
      pagination: page > 1 ? { currentPage: page } : {},
      isMapVisible: true,
      mapBounds: { north: 25.979434, south: 25.438376, east: -80.087849, west: -80.637969 },
      regionSelection: [{ regionId: 12086, regionType: 4 }],
      filterState: {
        isForSaleByAgent: { value: true },
        isForSaleByOwner: { value: true },
        isNewConstruction: { value: true },
        isForSaleForeclosure: { value: true },
        isComingSoon: { value: true },
        isAuction: { value: true },
        isPreMarketForeclosure: { value: false },
        isPreMarketPreForeclosure: { value: false },
        price: { max: 1000000 },
        isOpenHousesOnly: { value: true },
        sortSelection: { value: "globalrelevanceex" }
      },
      isListVisible: true
    },
    wants: { cat1: ["listResults"] },
    requestId: page,
    isDebugRequest: false
  };

  const resp = await fetch('https://www.zillow.com/async-create-search-page-state', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.zillow.com/miami-dade-county-fl/',
      'Origin': 'https://www.zillow.com'
    },
    body: JSON.stringify(searchQuery)
  });

  if (!resp.ok) throw new Error('Zillow returned ' + resp.status);
  return resp.json();
}

function extractListings(data) {
  const list = data?.cat1?.searchResults?.listResults || [];
  return list.map(s => ({
    address: s.address,
    zip: s.addressZipcode || s.hdpData?.homeInfo?.zipcode,
    price: s.unformattedPrice || s.price,
    beds: s.beds,
    baths: s.baths,
    detailUrl: s.detailUrl,
    ohStart: s.openHouseStartDate,
    ohEnd: s.openHouseEndDate,
    lat: s.latLong?.latitude,
    lng: s.latLong?.longitude,
    zpid: s.zpid
  }));
}

async function fetchAgentInfo(detailUrl) {
  try {
    const resp = await fetch(detailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await resp.text();

    const agentMatch = html.match(/\\\\"agentName\\\\":\\s*\\\\"([^\\\\]*?)\\\\"/);
    const phoneMatch = html.match(/\\\\"agentPhoneNumber\\\\":\\s*\\\\"([^\\\\]*?)\\\\"/);
    const brokerMatch = html.match(/\\\\"brokerName\\\\":\\s*\\\\"([^\\\\]*?)\\\\"/);

    return {
      agentName: agentMatch?.[1] || '',
      agentPhone: phoneMatch?.[1] || '',
      brokerName: brokerMatch?.[1] || ''
    };
  } catch (e) {
    return { agentName: '', agentPhone: '', brokerName: '' };
  }
}

function selectBestZips(listings, dates, excludeZip = null) {
  const byZip = {};
  listings.forEach(l => {
    if (!l.zip || !RINGS[l.zip]) return;
    if (excludeZip && l.zip === excludeZip) return;
    if (!byZip[l.zip]) byZip[l.zip] = [];
    byZip[l.zip].push(l);
  });

  const ranked = Object.entries(byZip)
    .map(([zip, arr]) => ({ zip, count: arr.length, ring: RINGS[zip] }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.ring - b.ring;
    });

  return ranked[0]?.zip || null;
}

function formatTime(iso) {
  if (!iso) return '?';
  const h = parseInt(iso.substring(11, 13));
  const m = iso.substring(14, 16);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ':' + m + ' ' + ap;
}

function buildGoogleMapsUrl(stops) {
  const base = 'https://www.google.com/maps/dir';
  const addresses = stops.map(s => encodeURIComponent(s.address));
  return base + '/' + addresses.join('/');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { saturday, sunday } = getNextWeekend();

    let allListings = [];
    const firstPage = await fetchZillowPage(1);
    const firstListings = extractListings(firstPage);
    allListings.push(...firstListings);

    const total = firstPage?.cat1?.searchList?.totalResultCount || 0;
    const perPage = firstListings.length || 41;
    const totalPages = Math.min(Math.ceil(total / perPage), 8);

    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(
        fetchZillowPage(p)
          .then(data => extractListings(data))
          .catch(() => [])
      );
    }
    const pageResults = await Promise.all(pagePromises);
    pageResults.forEach(listings => allListings.push(...listings));

    const satListings = allListings.filter(l => l.ohStart?.startsWith(saturday));
    const sunListings = allListings.filter(l => l.ohStart?.startsWith(sunday));

    const satZip = selectBestZips(satListings, saturday);
    const sunZip = selectBestZips(sunListings, sunday, satZip);

    const satSelected = satZip
      ? satListings.filter(l => l.zip === satZip).sort((a,b) => (a.ohStart||'').localeCompare(b.ohStart||'')).slice(0, 5)
      : [];
    const sunSelected = sunZip
      ? sunListings.filter(l => l.zip === sunZip).sort((a,b) => (a.ohStart||'').localeCompare(b.ohStart||'')).slice(0, 5)
      : [];

    const allSelected = [...satSelected, ...sunSelected];
    const agentPromises = allSelected.map(l => fetchAgentInfo(l.detailUrl));
    const agentResults = await Promise.all(agentPromises);

    const enrich = (listing, agentInfo) => ({
      ...listing,
      ...agentInfo,
      distMiles: haversine(BASE_LAT, BASE_LNG, listing.lat, listing.lng).toFixed(1),
      ohTimeStart: formatTime(listing.ohStart),
      ohTimeEnd: formatTime(listing.ohEnd)
    });

    const satFinal = satSelected.map((l, i) => enrich(l, agentResults[i]));
    const sunFinal = sunSelected.map((l, i) => enrich(l, agentResults[satSelected.length + i]));

    const satMapsUrl = satFinal.length ? buildGoogleMapsUrl(satFinal) : null;
    const sunMapsUrl = sunFinal.length ? buildGoogleMapsUrl(sunFinal) : null;

    return res.status(200).json({
      generated: new Date().toISOString(),
      weekend: { saturday, sunday },
      totalFound: allListings.length,
      saturday: {
        zip: satZip,
        ring: satZip ? RINGS[satZip] : null,
        count: satFinal.length,
        mapsUrl: satMapsUrl,
        stops: satFinal
      },
      sunday: {
        zip: sunZip,
        ring: sunZip ? RINGS[sunZip] : null,
        count: sunFinal.length,
        mapsUrl: sunMapsUrl,
        stops: sunFinal
      }
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'Error al buscar open houses',
      message: error.message
    });
  }
}
