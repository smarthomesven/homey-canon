'use strict';

const axios = require('axios');
const dgram = require('dgram');
const os = require('os');
const { URL } = require('url');

const DISCOVERY_TIMEOUT_MS = 4500;
const VALIDATION_TIMEOUT_MS = 4000;
const DESCRIPTION_TIMEOUT_MS = 2500;
const SUBNET_SCAN_TIMEOUT_MS = 1200;
const SUBNET_SCAN_CONCURRENCY = 24;
const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:Printer:1',
  'upnp:rootdevice',
  'ssdp:all',
];
const CANON_HINTS = ['canon', 'printer', 'pixma', 'maxify', 'imageclass', 'lbp', 'mf'];

async function detectCanonPrinter(ip, options = {}) {
  const timeout = options.timeout ?? VALIDATION_TIMEOUT_MS;

  if (!ip) {
    throw new Error('Printer IP address is required');
  }

  try {
    const response = await axios.get(`http://${ip}/JS_MDL/model.js`, { timeout });
    if (!isCanonStatusScript(response.data)) {
      throw new Error('Unexpected model.js payload');
    }
    return { ip, method: 1 };
  } catch (method1Error) {
    try {
      const [statusPageResponse, modelResponse] = await Promise.all([
        axios.get(`http://${ip}/errindex.html`, { timeout }),
        axios.get(`http://${ip}/js/model.js`, { timeout }),
      ]);
      if (!looksLikeCanonStatusPage(statusPageResponse.data) || !isCanonStatusScript(modelResponse.data)) {
        throw new Error('Unexpected method 2 payload');
      }
      return { ip, method: 2 };
    } catch (method2Error) {
      const error = new Error(`Printer validation failed for ${ip}`);
      error.method1Error = method1Error;
      error.method2Error = method2Error;
      throw error;
    }
  }
}

async function discoverCanonPrinters(options = {}) {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const responses = await performSsdpDiscovery(timeoutMs);
  const candidates = dedupeCandidates(responses);
  const discovered = await Promise.all(candidates.map((candidate) => inspectCandidate(candidate)));
  const printers = new Map();

  for (const printer of discovered) {
    if (!printer) {
      continue;
    }

    if (!printers.has(printer.ip)) {
      printers.set(printer.ip, printer);
    }
  }

  if (printers.size === 0) {
    const scannedPrinters = await discoverCanonPrintersBySubnet();
    for (const printer of scannedPrinters) {
      if (!printers.has(printer.ip)) {
        printers.set(printer.ip, printer);
      }
    }
  }

  return Array.from(printers.values()).sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return left.ip.localeCompare(right.ip);
  });
}

async function discoverCanonPrintersBySubnet() {
  const ipsToProbe = getSubnetProbeAddresses();
  const discovered = new Map();

  await runWithConcurrency(ipsToProbe, SUBNET_SCAN_CONCURRENCY, async (ip) => {
    try {
      const detected = await detectCanonPrinter(ip, { timeout: SUBNET_SCAN_TIMEOUT_MS });
      if (!discovered.has(ip)) {
        discovered.set(ip, {
          ip,
          method: detected.method,
          name: `Canon Printer (${ip})`,
        });
      }
    } catch (error) {
      // Most hosts on the subnet are not printers; ignore probe failures.
    }
  });

  return Array.from(discovered.values());
}

function performSsdpDiscovery(timeoutMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const responses = [];
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;

      try {
        socket.close();
      } catch (error) {
        // Ignore socket shutdown issues and resolve with what we already have.
      }

      resolve(responses);
    };

    socket.on('message', (message, remote) => {
      const headers = parseSsdpHeaders(message.toString());
      responses.push({
        address: remote.address,
        headers,
      });
    });

    socket.on('error', () => {
      finish();
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(2);
      } catch (error) {
        // Discovery can still work without these options on some runtimes.
      }

      for (const searchTarget of SEARCH_TARGETS) {
        const payload = buildSearchPacket(searchTarget);
        socket.send(payload, SSDP_PORT, SSDP_ADDRESS);
      }

      setTimeout(finish, timeoutMs);
    });
  });
}

function buildSearchPacket(searchTarget) {
  return Buffer.from([
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 2',
    `ST: ${searchTarget}`,
    '',
    '',
  ].join('\r\n'));
}

function parseSsdpHeaders(message) {
  const headers = {};
  const lines = message.split(/\r?\n/);

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function dedupeCandidates(responses) {
  const candidates = new Map();

  for (const response of responses) {
    const location = response.headers.location || '';
    const hint = buildHintText(response.headers, response.address);
    const isRelevant = location || hasCanonHint(hint);

    if (!isRelevant) {
      continue;
    }

    const key = location || response.address;
    if (!candidates.has(key)) {
      candidates.set(key, response);
    }
  }

  return Array.from(candidates.values());
}

async function inspectCandidate(candidate) {
  const metadata = await getCandidateMetadata(candidate);
  const ip = metadata.ip || candidate.address;

  if (!ip || !metadata.isCanon) {
    return null;
  }

  try {
    const detected = await detectCanonPrinter(ip, { timeout: DESCRIPTION_TIMEOUT_MS });
    return {
      ip,
      method: detected.method,
      name: metadata.name || `Canon Printer (${ip})`,
    };
  } catch (error) {
    return null;
  }
}

async function getCandidateMetadata(candidate) {
  const hint = buildHintText(candidate.headers, candidate.address);
  const location = candidate.headers.location;
  const fallback = {
    ip: candidate.address,
    isCanon: hasCanonHint(hint),
    name: hasCanonHint(hint) ? `Canon Printer (${candidate.address})` : null,
  };

  if (!location) {
    return fallback;
  }

  const description = await fetchDeviceDescription(location, candidate.address);
  if (!description) {
    return fallback;
  }

  const manufacturer = (description.manufacturer || '').toLowerCase();
  const modelName = (description.modelName || '').toLowerCase();
  const friendlyName = (description.friendlyName || '').toLowerCase();
  const descriptionText = `${manufacturer} ${modelName} ${friendlyName}`;
  const isCanon = manufacturer.includes('canon')
    || hasCanonHint(descriptionText)
    || hasCanonHint(hint);

  return {
    ip: candidate.address,
    isCanon,
    name: formatPrinterName(description, candidate.address),
  };
}

async function fetchDeviceDescription(location, address) {
  for (const candidateLocation of buildLocationCandidates(location, address)) {
    try {
      const response = await axios.get(candidateLocation, {
        timeout: DESCRIPTION_TIMEOUT_MS,
        maxRedirects: 1,
      });

      return parseDeviceDescription(response.data);
    } catch (error) {
      // Try the next location variant if the advertised hostname is not reachable.
    }
  }

  return null;
}

function buildLocationCandidates(location, address) {
  const locations = [location];

  try {
    const parsed = new URL(location);
    if (parsed.hostname !== address) {
      parsed.hostname = address;
      locations.push(parsed.toString());
    }
  } catch (error) {
    // Ignore malformed locations and keep the original value.
  }

  return locations;
}

function parseDeviceDescription(xml) {
  if (typeof xml !== 'string') {
    return null;
  }

  return {
    manufacturer: extractXmlTag(xml, 'manufacturer'),
    friendlyName: extractXmlTag(xml, 'friendlyName'),
    modelName: extractXmlTag(xml, 'modelName'),
  };
}

function extractXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) {
    return null;
  }

  return decodeXmlEntities(match[1].trim());
}

function decodeXmlEntities(value) {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatPrinterName(description, address) {
  const friendlyName = description.friendlyName;
  const modelName = description.modelName;

  if (friendlyName && modelName && friendlyName !== modelName) {
    return `${friendlyName} (${modelName})`;
  }

  if (friendlyName) {
    return friendlyName;
  }

  if (modelName) {
    return modelName;
  }

  return `Canon Printer (${address})`;
}

function buildHintText(headers, address) {
  return [
    headers.server,
    headers.st,
    headers.usn,
    headers.location,
    address,
  ].filter(Boolean).join(' ').toLowerCase();
}

function hasCanonHint(value) {
  return CANON_HINTS.some((hint) => value.includes(hint));
}

function isCanonStatusScript(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return /var\s+inktank\s*=\s*\[\]/i.test(value)
    && /var\s+inkCOL\s*=\s*\[/i.test(value)
    && /(g_signal_strength|g_help_url|canon)/i.test(value);
}

function looksLikeCanonStatusPage(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return /canon/i.test(value)
    || /errindex/i.test(value)
    || /Signal Strength/i.test(value);
}

function getSubnetProbeAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  const seen = new Set();

  for (const networkInterface of Object.values(interfaces)) {
    for (const details of networkInterface || []) {
      if (!details || details.internal || details.family !== 'IPv4') {
        continue;
      }

      if (!isPrivateIpv4(details.address)) {
        continue;
      }

      for (const ip of expandSubnet(details.address, details.netmask)) {
        if (!seen.has(ip)) {
          seen.add(ip);
          addresses.push(ip);
        }
      }
    }
  }

  return addresses;
}

function expandSubnet(address, netmask) {
  const addressInt = ipv4ToInt(address);
  const maskInt = ipv4ToInt(netmask);

  if (addressInt === null || maskInt === null) {
    return [];
  }

  const prefixLength = getPrefixLength(maskInt);
  let start;
  let end;

  if (prefixLength >= 24) {
    const networkInt = addressInt & maskInt;
    const broadcastInt = networkInt | (~maskInt >>> 0);
    start = networkInt + 1;
    end = broadcastInt - 1;
  } else {
    const octets = address.split('.').map(Number);
    start = ipv4ToInt(`${octets[0]}.${octets[1]}.${octets[2]}.1`);
    end = ipv4ToInt(`${octets[0]}.${octets[1]}.${octets[2]}.254`);
  }

  const localIp = ipv4ToInt(address);
  const ips = [];

  for (let current = start; current <= end; current += 1) {
    if (current === localIp) {
      continue;
    }

    ips.push(intToIpv4(current));
  }

  return ips;
}

function ipv4ToInt(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }

  return (((parts[0] << 24) >>> 0)
    | (parts[1] << 16)
    | (parts[2] << 8)
    | parts[3]) >>> 0;
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function getPrefixLength(maskInt) {
  let bits = 0;
  let value = maskInt >>> 0;

  while (value & 0x80000000) {
    bits += 1;
    value = (value << 1) >>> 0;
  }

  return bits;
}

function isPrivateIpv4(address) {
  const [first, second] = address.split('.').map(Number);
  if (first === 10) {
    return true;
  }

  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }

  return first === 192 && second === 168;
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = [];

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex]);
    }
  };

  for (let index = 0; index < Math.min(concurrency, items.length); index += 1) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
}

module.exports = {
  detectCanonPrinter,
  discoverCanonPrinters,
};
