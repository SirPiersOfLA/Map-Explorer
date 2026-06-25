const https = require('https');

const API_KEY = 'ad77b8ddd1fcaf10403972ac81756f4b69bb019f';
const GOOGLE_API_KEY = 'AIzaSyBF4CEpUsIQ_HnAJCVP8-8jSPkwwwBSSko';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://api.census.gov${res.headers.location}`;
        return resolve(get(next, redirects + 1));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function httpGet(url, timeoutMs=8000) {
  const mod = url.startsWith('https') ? https : require('http');
  const ua = url.includes('nominatim') 
    ? 'WhoLivesHereApp/1.0 (demographics dashboard; contact@example.com)'
    : 'Mozilla/5.0';
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: { 'User-Agent': ua } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`httpGet ${url.slice(0,80)} → status ${res.statusCode}, body[:100]: ${data.slice(0,100)}`);
        resolve({ status: res.statusCode, body: data });
      });
    }).on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('httpGet timeout')); }, timeoutMs);
  });
}

async function resolveZip(address) {
  // 1. Pure 5-digit ZIP
  if (/^\d{5}(-\d{4})?$/.test(address.trim())) return { zip: address.trim().slice(0, 5) };

  // 2. ZIP at end of string — but only if it's a short input (just a ZIP or city+ZIP)
  // For full street addresses containing a ZIP, fall through to geocoder to get lat/lng
  const m = address.match(/[\s,](\d{5})(-\d{4})?(\s*)$/);
  if (m && address.trim().length <= 10) return { zip: m[1] };

  // 3. Census geocoder (best for street addresses)
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    const { body } = await httpGet(url);
    const d = JSON.parse(body);
    const match = d?.result?.addressMatches?.[0];
    if (match?.addressComponents?.zip) {
      return { zip: match.addressComponents.zip.slice(0, 5), lat: match.coordinates?.y, lng: match.coordinates?.x };
    }
  } catch(e) {}

  // 4. Census city/place geocoder
  try {
    const parts = address.split(',').map(s => s.trim());
    const city = parts[0];
    const state = parts[1] || '';
    const url = `https://geocoding.geo.census.gov/geocoder/locations/address?street=1+Main+St&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&benchmark=Public_AR_Current&format=json`;
    const { body } = await httpGet(url);
    const d = JSON.parse(body);
    const match = d?.result?.addressMatches?.[0];
    console.log('Census city result:', JSON.stringify(match?.addressComponents));
    if (match?.addressComponents?.zip) {
      return { zip: match.addressComponents.zip.slice(0,5), lat: match.coordinates?.y, lng: match.coordinates?.x };
    }
  } catch(e) { console.log('Census city error:', e.message); }

  // 5. Zippopotam.us — free, no key, city+state → ZIP codes
  try {
    const parts = address.split(',').map(s => s.trim());
    const city = parts[0].replace(/\s+/g, '%20');
    const state = (parts[1] || '').trim().slice(0,2).toUpperCase();
    if (state.length === 2) {
      const url = `https://api.zippopotam.us/us/${state}/${city}`;
      const { body, status } = await httpGet(url);
      console.log('Zippopotam status:', status, 'body:', body.slice(0,300));
      if (status === 200) {
        const d = JSON.parse(body);
        const places = d?.places || [];
        // Filter likely PO box ZIPs to the end
        const filtered = places.filter(p => {
          const z = p['post code'];
          return z && !z.endsWith('09') && !z.endsWith('01') && !z.endsWith('99') && !z.endsWith('98');
        });
        const ranked = [...filtered, ...places.filter(p => !filtered.includes(p))];
        const zips = ranked
          .map(p => ({ zip: p['post code'].slice(0,5), lat: parseFloat(p.latitude), lng: parseFloat(p.longitude) }))
          .filter(p => p.zip.length === 5);
        if (zips.length) return { zip: zips[0].zip, lat: zips[0].lat, lng: zips[0].lng, fallbacks: zips.slice(1,4) };
      }
    }
  } catch(e) { console.log('Zippopotam error:', e.message); }

  return null;
}

exports.handler = async (event) => {
  const GOOGLE_API_KEY = 'AIzaSyBF4CEpUsIQ_HnAJCVP8-8jSPkwwwBSSko';
const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const q = event.queryStringParameters || {};

  // Distance Matrix proxy (avoids CORS when called from browser)
  if (q.distancematrix) {
    try {
      const { olat, olng, dlat, dlng } = q;
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${olat},${olng}&destinations=${dlat},${dlng}&mode=driving&key=${GOOGLE_API_KEY}`;
      const { body } = await httpGet(url, 8000);
      return { statusCode: 200, headers: cors, body };
    } catch(e) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Reverse geocode: lat,lng → ZIP
  if (q.address && /^-?\d+\.?\d*,-?\d+\.?\d*$/.test(q.address.trim())) {
    try {
      const [lat, lng] = q.address.split(',');
      console.log('Reverse geocode:', lat, lng);

      // Try Google first
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_API_KEY}`;
      const { body } = await httpGet(url, 8000);
      const d = JSON.parse(body);
      console.log('Google status:', d.status, 'results:', d.results?.length);

      if (d.status === 'OK') {
        for (const result of d.results) {
          const zipComp = result.address_components?.find(c => c.types.includes('postal_code'));
          if (zipComp) {
            const zip = zipComp.short_name.slice(0, 5);
            // Get a clean street address (street number + route + city + state + zip)
            const num   = result.address_components?.find(c => c.types.includes('street_number'))?.long_name || '';
            const route = result.address_components?.find(c => c.types.includes('route'))?.long_name || '';
            const city  = result.address_components?.find(c => c.types.includes('locality'))?.long_name || '';
            const state = result.address_components?.find(c => c.types.includes('administrative_area_level_1'))?.short_name || '';
            const street = num && route ? `${num} ${route}, ${city}, ${state} ${zip}` : result.formatted_address || '';
            console.log('Found ZIP from Google:', zip, 'street:', street);
            return { statusCode: 200, headers: cors, body: JSON.stringify({ zip, lat: parseFloat(lat), lng: parseFloat(lng), street }) };
          }
        }
        // Second attempt with result_type=postal_code
        const url2 = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=postal_code&key=${GOOGLE_API_KEY}`;
        const { body: body2 } = await httpGet(url2, 8000);
        const d2 = JSON.parse(body2);
        if (d2.status === 'OK' && d2.results?.[0]) {
          const zipComp = d2.results[0].address_components?.find(c => c.types.includes('postal_code'));
          if (zipComp) {
            const zip = zipComp.short_name.slice(0, 5);
            console.log('Found ZIP from Google postal_code filter:', zip);
            return { statusCode: 200, headers: cors, body: JSON.stringify({ zip, lat: parseFloat(lat), lng: parseFloat(lng) }) };
          }
        }
      }

      // Fallback: Census Tiger coordinate lookup
      const censusUrl = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lng}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
      try {
        const { body: cb } = await httpGet(censusUrl, 8000);
        const cd = JSON.parse(cb);
        const geos = cd?.result?.geographies || {};
        console.log('Census geo keys:', Object.keys(geos).join(', '));
        // Try all possible ZIP geography key names
        const zipGeo = geos['2020 ZIP Code Tabulation Areas']
                    || geos['ZIP Code Tabulation Areas']
                    || geos['Zip Code Tabulation Areas']
                    || geos['ZCTA5'] || [];
        if (zipGeo.length > 0) {
          const zip = (zipGeo[0].GEOID || zipGeo[0].ZCTA5CE20 || zipGeo[0].ZCTA5CE10 || '').slice(0,5);
          if (zip) {
            console.log('Found ZIP from Census:', zip);
            return { statusCode: 200, headers: cors, body: JSON.stringify({ zip, lat: parseFloat(lat), lng: parseFloat(lng) }) };
          }
        }
        // Log what we got for debugging
        console.log('Census ZIP geo not found. Keys:', JSON.stringify(Object.keys(geos)));
      } catch(ce) { console.log('Census fallback error:', ce.message); }

      console.log('No ZIP found from any source');
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'No ZIP found for these coordinates.' }) };
    } catch(e) {
      console.log('Reverse geocode error:', e.message);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Address → ZIP mode
  if (q.address) {
    try {
      console.log('resolveZip input:', q.address);
      const result = await resolveZip(q.address);
      console.log('resolveZip result:', JSON.stringify(result));
      if (!result?.zip) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Could not find a ZIP code for that location. Try adding a city and state, or enter the ZIP directly.' }) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ zip: result.zip, lat: result.lat, lng: result.lng, fallbacks: result.fallbacks||[] }) };
    } catch (e) {
      console.log('resolveZip error:', e.message, e.stack);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Geocoding failed: ' + e.message }) };
    }
  }

  // Caltrans AADT traffic data
  // Anchor retail proximity — query OSM for nearby anchor stores
  if (q.anchors) {
    try {
      const lat = parseFloat(q.lat);
      const lng = parseFloat(q.lng);
      if(isNaN(lat)||isNaN(lng)) throw new Error('Invalid coordinates');
      const radiusM = 1609; // 1 mile in metres

      // Query by both name and brand tags, include ways with center
      const query = `[out:json][timeout:10];
(
  nwr["name"~"home depot",i](around:${radiusM},${lat},${lng});
  nwr["name"~"^target$",i](around:${radiusM},${lat},${lng});
  nwr["name"~"costco",i](around:${radiusM},${lat},${lng});
  nwr["name"~"sam.s club",i](around:${radiusM},${lat},${lng});
  nwr["name"~"trader joe",i](around:${radiusM},${lat},${lng});
  nwr["name"~"marshalls",i](around:${radiusM},${lat},${lng});
  nwr["brand"~"home depot",i](around:${radiusM},${lat},${lng});
  nwr["brand"~"^target$",i](around:${radiusM},${lat},${lng});
  nwr["brand"~"costco",i](around:${radiusM},${lat},${lng});
  nwr["brand"~"sam.s club",i](around:${radiusM},${lat},${lng});
  nwr["brand"~"trader joe",i](around:${radiusM},${lat},${lng});
  nwr["brand"~"marshalls",i](around:${radiusM},${lat},${lng});
);
out center tags;`;

      const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
      const { status, body } = await httpGet(url, 10000);
      if(status !== 200) throw new Error('Overpass API returned ' + status);
      const data = JSON.parse(body);

      function dist(lat1,lng1,lat2,lng2){
        const R=3959,dLat=(lat2-lat1)*Math.PI/180,dLng=(lng2-lng1)*Math.PI/180;
        const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
        return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      }

      const anchors = [
        {key:'Home Depot',   pattern:/home depot/i},
        {key:'Target',       pattern:/^target$/i},
        {key:'Costco',       pattern:/costco/i},
        {key:"Sam's Club",   pattern:/sam.s club/i},
        {key:"Trader Joe's", pattern:/trader joe/i},
        {key:'Marshalls',    pattern:/marshalls/i},
      ];

      const found = {};
      for(const el of data.elements||[]) {
        const name  = el.tags?.name  || '';
        const brand = el.tags?.brand || '';
        const elLat = el.lat ?? el.center?.lat;
        const elLng = el.lon ?? el.center?.lon;
        if(!elLat || !elLng) continue;
        const d = dist(lat, lng, elLat, elLng);
        if(d > 1.05) continue;
        for(const anchor of anchors) {
          if(anchor.pattern.test(name) || anchor.pattern.test(brand)) {
            if(!found[anchor.key] || found[anchor.key].dist > d) {
              found[anchor.key] = { name: anchor.key, dist: Math.round(d*10)/10 };
            }
          }
        }
      }

      const results = Object.values(found).sort((a,b) => a.dist - b.dist);
      console.log('Anchor results:', JSON.stringify(results));
      return { statusCode:200, headers:{...cors,'Cache-Control':'public, max-age=86400'},
               body: JSON.stringify({ anchors: results }) };
    } catch(e) {
      console.log('Anchors error:', e.message);
      return { statusCode:500, headers:cors, body: JSON.stringify({ error: e.message, anchors:[] }) };
    }
  }

  if (q.aadt) {
    try {
      const lat = parseFloat(q.lat);
      const lng = parseFloat(q.lng);
      if(isNaN(lat)||isNaN(lng)) throw new Error('Invalid coordinates');
      // Search 3-mile bounding box
      const delta = 0.045; // ~3 miles
      const bbox = `${lng-delta},${lat-delta},${lng+delta},${lat+delta}`;
      const url = `https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/Traffic_AADT/FeatureServer/0/query?where=1%3D1&geometry=${encodeURIComponent(bbox)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=DISTRICT%2CRTE%2CPM%2CDESCRIPTION%2CAHEAD_AADT%2CBACK_AADT&returnGeometry=true&outSR=4326&f=json&resultRecordCount=20`;
      console.log('AADT request for', lat, lng);
      const { status, body } = await httpGet(url, 9000);
      console.log('AADT response:', status, body.slice(0,150));
      if(status !== 200) throw new Error('AADT API returned ' + status);
      return { statusCode: 200, headers: { ...cors, 'Cache-Control': 'public, max-age=86400' }, body };
    } catch(e) {
      console.log('AADT error:', e.message);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }
  if (q.catchment) {
    try {
      const lat = parseFloat(q.lat);
      const lng = parseFloat(q.lng);
      const radiusMiles = parseFloat(q.radius || 5);
      if(isNaN(lat) || isNaN(lng)) throw new Error('Invalid coordinates');

      const latDeg = radiusMiles / 69.0;
      const lngDeg = radiusMiles / (69.0 * Math.cos(lat * Math.PI / 180));
      const bbox = `${lng-lngDeg},${lat-latDeg},${lng+lngDeg},${lat+latDeg}`;
      const tigerUrl = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/84/query?geometry=${encodeURIComponent(bbox)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=BASENAME,CENTLAT,CENTLON&returnGeometry=false&f=json`;
      const tigerRes = await httpGet(tigerUrl);
      const tigerData = JSON.parse(tigerRes.body);
      const features = tigerData.features || [];

      function dist(lat1, lng1, lat2, lng2) {
        const R = 3959;
        const dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
        return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      }

      const nearbyZips = features
        .filter(f => dist(lat,lng,parseFloat(f.attributes.CENTLAT),parseFloat(f.attributes.CENTLON)) <= radiusMiles)
        .map(f => f.attributes.BASENAME).filter(z => z&&z.length===5).slice(0,20);

      console.log('Catchment ZIPs:', nearbyZips.length, nearbyZips.join(','));
      if(!nearbyZips.length) throw new Error('No ZIPs found within radius');

      const vars = 'B01003_001E,B01002_001E,B19013_001E,B25077_001E,B25003_001E,B25003_002E,B08201_001E,B08201_004E,B08201_005E,B08201_006E,B15003_001E,B15003_022E,B15003_023E,B15003_024E,B15003_025E';
      const fetchZip = async (z) => {
        try {
          const res = await get(`https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=zip+code+tabulation+area:${z}&key=${API_KEY}`);
          if(res.status!==200) return null;
          const d = JSON.parse(res.body);
          if(!Array.isArray(d)||d.length<2) return null;
          const h=d[0], v=d[1];
          const gi=k=>{const i=h.indexOf(k);return i>=0&&v[i]&&v[i]!=='-666666666'?parseInt(v[i]):0;};
          const gf=k=>{const i=h.indexOf(k);return i>=0&&v[i]&&v[i]!=='-666666666'?parseFloat(v[i]):0;};
          return { zip:z, pop:gi('B01003_001E'), age:gf('B01002_001E'), inc:gi('B19013_001E'), home:gi('B25077_001E'),
            ownTot:gi('B25003_001E'), owned:gi('B25003_002E'), vehTot:gi('B08201_001E'),
            multiVeh:gi('B08201_004E')+gi('B08201_005E')+gi('B08201_006E'),
            eduTot:gi('B15003_001E'), college:gi('B15003_022E')+gi('B15003_023E')+gi('B15003_024E')+gi('B15003_025E') };
        } catch(e){ return null; }
      };

      const results = (await Promise.all(nearbyZips.map(fetchZip))).filter(r=>r&&r.pop>0);
      if(!results.length) throw new Error('No Census data returned');

      const totalPop = results.reduce((a,r)=>a+r.pop,0);
      const wavg = key => Math.round(results.reduce((a,r)=>a+r[key]*r.pop,0)/totalPop);
      const wpct = (n,d) => Math.round(results.reduce((a,r)=>a+(r[d]>0?r[n]/r[d]:0)*r.pop,0)/totalPop*100);

      return { statusCode:200, headers:{...cors,'Cache-Control':'no-store'}, body: JSON.stringify({
        zips: results.map(r=>r.zip), totalPop,
        medInc: wavg('inc'), medHome: wavg('home'),
        medAge: Math.round(results.reduce((a,r)=>a+r.age*r.pop,0)/totalPop*10)/10,
        ownPct: wpct('owned','ownTot'), multiVehPct: wpct('multiVeh','vehTot'), collegePct: wpct('college','eduTot'),
      })};
    } catch(e) {
      console.log('Catchment error:', e.message);
      return { statusCode:500, headers:cors, body:JSON.stringify({error:e.message}) };
    }
  }

  // Consumer spending from Colliers/ESRI
  if (q.spending) {
    try {
      const zip = q.spending;
      const fields = [
        'id','name',
        'spendingtotal_x1001_x_a',  // Annual Budget Expenditures avg
        'spendingtotal_x15001_x_a', // Retail Goods avg
        'spendingtotal_x15001_x_i', // Retail Goods index
        'clothing_x5001_x_a',       // Apparel avg
        'clothing_x5001_x_i',       // Apparel index
        'entertainment_x9001_x_a',  // Entertainment avg
        'entertainment_x9001_x_i',  // Entertainment index
        'travelcex_x7001_x_a',      // Travel avg
        'travelcex_x7001_x_i',      // Travel index
        'housinghousehold_x3001_x_a', // Housing avg
        'housinghousehold_x3001_x_i', // Housing index
        'food_x1002_x_a',           // Food avg
        'food_x1002_x_i',           // Food index
        'entertainment_x9040_x_a',  // Toys/Games avg
        'entertainment_x9040_x_i',  // Toys/Games index
      ].join(',');
      const url = `https://atlas.colliers.com/server/rest/services/Hosted/SpendingByZip24/FeatureServer/0/query?f=json&where=id%3D%27${zip}%27&outFields=${encodeURIComponent(fields)}&returnGeometry=false&resultRecordCount=1`;
      console.log('Spending request for ZIP:', zip);
      const { status, body } = await httpGet(url);
      console.log('Spending response:', status, body.slice(0,150));
      if(status !== 200) throw new Error('Spending API returned ' + status);
      return { statusCode: 200, headers: { ...cors, 'Cache-Control': 'public, max-age=86400' }, body };
    } catch(e) {
      console.log('Spending error:', e.message);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }
  if (q.cbp) {
    try {
      const naics = q.naics || '00';
      const url = `https://api.census.gov/data/2021/cbp?get=ESTAB,EMP,NAICS2017_LABEL&for=zipcode:${q.cbp}&NAICS2017=${naics}&key=${API_KEY}`;
      console.log('CBP request:', url);
      const { status, body } = await get(url);
      console.log('CBP response:', status, body.slice(0,150));
      return { statusCode: status, headers: { ...cors, 'Cache-Control': 'public, max-age=86400' }, body };
    } catch(e) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ZCTA boundary mode
  if (q.zcta) {    try {
      const zip = q.zcta;
      const type = q.type || 'single';
      let url;
      if (type === 'single') {
        url = `https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/tigerWMS_Census2020/MapServer/84/query?where=BASENAME%3D'${zip}'&outFields=BASENAME&outSR=4326&f=geojson`;
      } else {
        url = `https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/tigerWMS_Census2020/MapServer/84/query?geometry=${encodeURIComponent(q.bbox)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=BASENAME&outSR=4326&f=geojson`;
      }
      console.log('ZCTA request:', url);
      const { status, body } = await httpGet(url);
      console.log('ZCTA response status:', status, 'body[:150]:', body.slice(0,150));
      return { statusCode: 200, headers: { ...cors, 'Cache-Control': 'public, max-age=86400' }, body };
    } catch(e) {
      console.log('ZCTA error:', e.message);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }
  // Similar neighborhoods — fetch all ZIPs in same state with key scoring vars
  if (q.similar) {
    try {
      const zip = q.similar;
      const zipNum = parseInt(zip);

      // Derive state FIPS directly from ZIP range
      let stateFips = '';
      if(zipNum>=90001&&zipNum<=96162) stateFips='06';
      else if(zipNum>=35004&&zipNum<=36925) stateFips='01';
      else if(zipNum>=99501&&zipNum<=99950) stateFips='02';
      else if(zipNum>=85001&&zipNum<=86556) stateFips='04';
      else if(zipNum>=71601&&zipNum<=72959) stateFips='05';
      else if(zipNum>=80001&&zipNum<=81658) stateFips='08';
      else if(zipNum>=6001&&zipNum<=6928) stateFips='09';
      else if(zipNum>=19701&&zipNum<=19980) stateFips='10';
      else if(zipNum>=32004&&zipNum<=34997) stateFips='12';
      else if(zipNum>=30001&&zipNum<=31999) stateFips='13';
      else if(zipNum>=96701&&zipNum<=96898) stateFips='15';
      else if(zipNum>=83201&&zipNum<=83876) stateFips='16';
      else if(zipNum>=60001&&zipNum<=62999) stateFips='17';
      else if(zipNum>=46001&&zipNum<=47997) stateFips='18';
      else if(zipNum>=50001&&zipNum<=52809) stateFips='19';
      else if(zipNum>=66002&&zipNum<=67954) stateFips='20';
      else if(zipNum>=40003&&zipNum<=42788) stateFips='21';
      else if(zipNum>=70001&&zipNum<=71497) stateFips='22';
      else if(zipNum>=3901&&zipNum<=4992) stateFips='23';
      else if(zipNum>=20601&&zipNum<=21930) stateFips='24';
      else if(zipNum>=1001&&zipNum<=2791) stateFips='25';
      else if(zipNum>=48001&&zipNum<=49971) stateFips='26';
      else if(zipNum>=55001&&zipNum<=56763) stateFips='27';
      else if(zipNum>=38601&&zipNum<=39776) stateFips='28';
      else if(zipNum>=63001&&zipNum<=65899) stateFips='29';
      else if(zipNum>=59001&&zipNum<=59937) stateFips='30';
      else if(zipNum>=68001&&zipNum<=69367) stateFips='31';
      else if(zipNum>=88901&&zipNum<=89883) stateFips='32';
      else if(zipNum>=3031&&zipNum<=3897) stateFips='33';
      else if(zipNum>=7001&&zipNum<=8989) stateFips='34';
      else if(zipNum>=87001&&zipNum<=88441) stateFips='35';
      else if(zipNum>=10001&&zipNum<=14975) stateFips='36';
      else if(zipNum>=27006&&zipNum<=28909) stateFips='37';
      else if(zipNum>=58001&&zipNum<=58856) stateFips='38';
      else if(zipNum>=43001&&zipNum<=45999) stateFips='39';
      else if(zipNum>=73001&&zipNum<=74966) stateFips='40';
      else if(zipNum>=97001&&zipNum<=97920) stateFips='41';
      else if(zipNum>=15001&&zipNum<=19640) stateFips='42';
      else if(zipNum>=2801&&zipNum<=2940) stateFips='44';
      else if(zipNum>=29001&&zipNum<=29948) stateFips='45';
      else if(zipNum>=57001&&zipNum<=57799) stateFips='46';
      else if(zipNum>=37010&&zipNum<=38589) stateFips='47';
      else if(zipNum>=75001&&zipNum<=79999) stateFips='48';
      else if(zipNum>=84001&&zipNum<=84784) stateFips='49';
      else if(zipNum>=5001&&zipNum<=5907) stateFips='50';
      else if(zipNum>=20101&&zipNum<=24658) stateFips='51';
      else if(zipNum>=98001&&zipNum<=99403) stateFips='53';
      else if(zipNum>=24701&&zipNum<=26886) stateFips='54';
      else if(zipNum>=53001&&zipNum<=54990) stateFips='55';
      else if(zipNum>=82001&&zipNum<=83128) stateFips='56';

      if (!stateFips) throw new Error('Could not determine state for ZIP ' + zip);
      console.log('State FIPS for', zip, ':', stateFips);

      // Fetch ~10 ZIPs near the current one in parallel
      const baseZip = parseInt(zip);
      const candidates = [];
      for(let i = -6; i <= 6; i++) {
        if(i===0) continue;
        const candidate = String(baseZip + i).padStart(5,'0');
        if(candidate.length === 5) candidates.push(candidate);
      }
      console.log('Fetching', candidates.length, 'candidate ZIPs');

      // Fetch each ZIP individually in parallel
      const fetchZip = async (z) => {
        try {
          const url = `https://api.census.gov/data/2022/acs/acs5?get=B19013_001E,B25077_001E,B25003_002E,B25003_001E,B01002_001E,B01003_001E&for=zip+code+tabulation+area:${z}&key=${API_KEY}`;
          const res = await get(url);
          if(res.status !== 200) return null;
          const d = JSON.parse(res.body);
          if(!Array.isArray(d)||d.length<2) return null;
          return { headers: d[0], row: d[1] };
        } catch(e) { return null; }
      };

      const fetched = await Promise.all(candidates.map(fetchZip));
      const valid = fetched.filter(Boolean);
      console.log('Got valid ZIP data for', valid.length, 'ZIPs');

      if(!valid.length) throw new Error('No ZIP data found for nearby area');
      const headers = valid[0].headers;
      const rows = valid.map(v=>v.row);
      return { statusCode: 200, headers: { ...cors, 'Cache-Control': 'public, max-age=3600' }, body: JSON.stringify({ headers, rows, stateFips }) };
    } catch(e) {
      console.log('Similar error:', e.message);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }
  const params = new URLSearchParams(q);
  params.set('key', API_KEY);
  const url = `https://api.census.gov/data/2022/acs/acs5?${params.toString()}`;
  console.log('ACS request:', url);
  try {
    const { status, body } = await get(url);
    console.log('ACS response status:', status);
    console.log('ACS response body (first 300):', body.slice(0, 300));
    return { statusCode: status, headers: cors, body };
  } catch (e) {
    console.log('ACS fetch error:', e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
