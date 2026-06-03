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
  const digits = phone.replace(/\D/g, '');
  const prefixDigits = mobilePrefix.replace(/\D/g, '');
  return digits.startsWith(prefixDigits) && digits.length >= 8 && digits.length <= 15;
}
