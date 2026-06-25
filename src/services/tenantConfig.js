const _cache = new Map();
import prisma from '../db.js';

const MARKET_NAMES = {
  MY: 'Malaysia', SG: 'Singapore', ID: 'Indonesia', PH: 'Philippines',
  IN: 'India', AU: 'Australia', GB: 'United Kingdom', US: 'United States',
  TH: 'Thailand', VN: 'Vietnam', AE: 'UAE', SA: 'Saudi Arabia',
};

const DEFAULT_CONFIG = {
  country: 'MY', currency: 'MYR', timezone: 'Asia/Kuala_Lumpur',
  mobilePrefix: '+60', languages: ['EN', 'MS'],
};

export async function getTenantConfig(tenantId) {
  if (!tenantId || tenantId === 'default') return DEFAULT_CONFIG;
  if (_cache.has(tenantId)) return _cache.get(tenantId);
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (tenant) {
      _cache.set(tenantId, tenant);
      // expire cache after 5 minutes
      setTimeout(() => _cache.delete(tenantId), 5 * 60 * 1000);
      return tenant;
    }
  } catch {}
  return DEFAULT_CONFIG;
}

export function getMarketName(country) {
  return MARKET_NAMES[country] || country;
}

export function formatCurrencyServer(amount, currency = 'MYR') {
  const symbols = { MYR: 'RM', USD: '$', GBP: '£', EUR: '€', SGD: 'S$', AUD: 'A$', IDR: 'Rp', THB: '฿', PHP: '₱', INR: '₹' };
  const sym = symbols[currency] || `${currency} `;
  return `${sym}${Math.round(amount).toLocaleString()}`;
}

export function isValidMobile(phone, mobilePrefix = '+60') {
  if (!phone) return false;
  let digits = phone.replace(/\D/g, '');
  const prefixDigits = mobilePrefix.replace(/\D/g, '');
  // Accept local format (e.g. 012-345 6789) by normalizing to the country code
  if (digits.startsWith('0') && !digits.startsWith(prefixDigits)) digits = prefixDigits + digits.slice(1);
  if (!digits.startsWith(prefixDigits)) return false;
  // Malaysia: only 601x numbers are mobiles — 603/604/… are landlines, not on WhatsApp
  if (prefixDigits === '60') return /^601\d{8,9}$/.test(digits);
  return digits.length >= 8 && digits.length <= 15;
}

// Classify a phone for outreach planning: 'mobile' (WhatsApp-capable),
// 'landline' (office number — Voice/Email only), or 'none' (no usable digits).
export function classifyPhone(phone, mobilePrefix = '+60') {
  if (!phone || !phone.replace(/\D/g, '')) return 'none';
  return isValidMobile(phone, mobilePrefix) ? 'mobile' : 'landline';
}
