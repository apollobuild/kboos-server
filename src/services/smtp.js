import nodemailer from 'nodemailer';

export async function sendViaSMTP({ smtpConfig, to, subject, body, fromName, replyTo }) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host || (smtpConfig.user?.includes('gmail') ? 'smtp.gmail.com' : 'smtp-mail.outlook.com'),
    port: smtpConfig.port || 587,
    secure: false,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });

  await transporter.sendMail({
    from: fromName ? `"${fromName}" <${smtpConfig.user}>` : smtpConfig.user,
    replyTo: replyTo || undefined,
    to,
    subject,
    text: body,
    html: body.replace(/\n/g, '<br>'),
  });
}

export async function testSMTP(smtpConfig) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host || 'smtp.gmail.com',
    port: smtpConfig.port || 587,
    secure: false,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });
  await transporter.verify();
  return true;
}
