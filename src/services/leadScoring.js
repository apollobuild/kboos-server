export function scoreLeadQuality(lead, campaignConfig = {}) {
  let score = 0;
  const signals = [];

  if (lead.phone) { score += 25; signals.push('Has phone'); }
  if (lead.email) { score += 20; signals.push('Has email'); }
  if (lead.website) { score += 10; signals.push('Has website'); }

  const rating = parseFloat(lead.rating || 0);
  const ratingOk = rating >= 3.5;
  if (rating >= 4.0) { score += 20; signals.push(`${rating}★ rating`); }
  else if (rating >= 3.5) { score += 10; signals.push(`${rating}★ rating`); }
  else if (rating > 0 && rating < 3.0) { score -= 5; signals.push('Low rating'); }

  const reviews = parseInt(lead.reviewCount || 0);
  if (reviews >= 50) { score += 15; signals.push(`${reviews} reviews`); }
  else if (reviews >= 10) { score += 8; signals.push(`${reviews} reviews`); }

  const keyword = (campaignConfig.keyword || '').toLowerCase();
  const category = (lead.category || lead.company || lead.title || '').toLowerCase();
  const categoryMatch = keyword.length > 0 && keyword.split(/\s+/).some(kw => kw.length > 2 && category.includes(kw));
  if (categoryMatch) { score += 10; signals.push('Category match'); }

  score = Math.max(0, Math.min(100, score));
  const tier = score >= 60 ? 'A' : score >= 35 ? 'B' : 'C';

  return { tier, qualityScore: score, signals, hasWebsite: !!lead.website, hasPhone: !!lead.phone, hasEmail: !!lead.email, categoryMatch, ratingOk };
}

export function isValidMalaysianMobile(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.startsWith('601') && digits.length >= 10 && digits.length <= 12;
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

export function checkChannelEligibility(lead) {
  const emailOk = isValidEmail(lead.email);
  const waOk = isValidMalaysianMobile(lead.phone);
  const voiceOk = waOk;
  return {
    emailEligible: emailOk,
    waEligible: waOk,
    voiceEligible: voiceOk,
    emailReason: emailOk ? null : (lead.email ? 'Invalid email format' : 'No email address'),
    waReason: waOk ? null : (lead.phone ? 'Not a valid MY mobile (needs 601x)' : 'No phone number'),
    voiceReason: voiceOk ? null : (lead.phone ? 'Not a valid MY mobile (needs 601x)' : 'No phone number'),
  };
}

export function injectPersonalization(template, lead, personalization = {}) {
  const firstName = lead.name?.split(' ')[0] || lead.name || 'there';
  let body = template;
  body = body.replace(/\{\{opening_line\}\}/g, personalization.openingLine || '');
  body = body.replace(/\{\{first_name\}\}/g, firstName);
  body = body.replace(/\{\{company\}\}/g, lead.company || '');
  body = body.replace(/\{\{title\}\}/g, lead.title || '');
  body = body.replace(/\{\{city\}\}/g, personalization.variables?.city || lead.address?.split(',')[1]?.trim() || 'Malaysia');
  body = body.replace(/\{\{industry\}\}/g, personalization.variables?.industry || lead.category || '');
  body = body.replace(/\{\{phone\}\}/g, lead.phone || '');
  return body;
}
