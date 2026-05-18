import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Only seed when explicitly requested — never run automatically in production
if (process.env.SEED_DB !== 'true') {
  console.log('Skipping seed (set SEED_DB=true to seed).');
  await prisma.$disconnect();
  process.exit(0);
}

async function main() {
  console.log('Seeding database...');

  // Default admin user
  const existing = await prisma.user.findUnique({ where: { email: 'admin@kboos.app' } });
  if (!existing) {
    await prisma.user.create({
      data: {
        email: 'admin@kboos.app',
        password: await bcrypt.hash('kboos2024', 10),
        name: 'KOBIS Admin',
        role: 'admin',
      }
    });
    console.log('Created admin user: admin@kboos.app / kboos2024');
  }

  // Seed businesses
  const bizCount = await prisma.business.count();
  if (bizCount === 0) {
    await prisma.business.createMany({ data: [
      { id:'GS', name:'Gadong Squad', industry:'Landscaping', color:'green', campaigns:2, leads:1044, hot:20, spend:'RM117', brief:'approved' },
      { id:'KV', name:'KOBIS Video', industry:'Media', color:'blue', campaigns:1, leads:156, hot:9, spend:'RM34', brief:'approved' },
      { id:'TS', name:'TechServ Kuching', industry:'IT', color:'purple', campaigns:1, leads:89, hot:3, spend:'RM21', brief:'pending' },
      { id:'AC', name:'Adura Clinic', industry:'Healthcare', color:'amber', campaigns:0, leads:0, hot:0, spend:'RM0', brief:'none', status:'setup' },
      { id:'GB', name:'GreenBuild Sarawak', industry:'Construction', color:'green', campaigns:2, leads:482, hot:7, spend:'RM67', brief:'approved' },
      { id:'SE', name:'Sarawak Edu Hub', industry:'Education', color:'cyan', campaigns:1, leads:201, hot:5, spend:'RM44', brief:'approved' },
    ]});
    console.log('Seeded 6 businesses');
  }

  // Seed campaigns
  const campCount = await prisma.campaign.count();
  if (campCount === 0) {
    await prisma.campaign.createMany({ data: [
      { bizId:'GS', bizName:'Gadong Squad', name:'Kuching Q2', status:'active', color:'green', leads:743, total:2400, hot:14, spend:'RM46', open:'38.2%', wa:'54%', tier:'Growth' },
      { bizId:'GS', bizName:'Gadong Squad', name:'Kota Samarahan', status:'active', color:'green', leads:301, total:1200, hot:6, spend:'RM28', open:'31.4%', wa:'48%', tier:'Starter' },
      { bizId:'KV', bizName:'KOBIS Video', name:'Sarawak GLCs', status:'active', color:'blue', leads:156, total:1200, hot:9, spend:'RM34', open:'41.7%', wa:'28%', tier:'Starter' },
      { bizId:'TS', bizName:'TechServ Kuching', name:'SME Kuching', status:'active', color:'purple', leads:89, total:600, hot:3, spend:'RM21', open:'29.3%', wa:'31%', tier:'Starter' },
      { bizId:'GB', bizName:'GreenBuild Sarawak', name:'Developers KCH', status:'awaiting_approval', color:'green', leads:50, total:800, hot:0, spend:'RM8', open:'0%', wa:'-', tier:'Growth' },
      { bizId:'GB', bizName:'GreenBuild Sarawak', name:'Contractors', status:'active', color:'green', leads:362, total:1000, hot:7, spend:'RM59', open:'35.1%', wa:'52%', tier:'Growth' },
      { bizId:'SE', bizName:'Sarawak Edu Hub', name:'Universities', status:'active', color:'cyan', leads:201, total:900, hot:5, spend:'RM44', open:'33.5%', wa:'46%', tier:'Starter' },
    ]});
    console.log('Seeded 7 campaigns');
  }

  // Seed replies
  const replyCount = await prisma.reply.count();
  if (replyCount === 0) {
    await prisma.reply.createMany({ data: [
      { name:'Sarah Lim', company:'Maybank', channel:'WA', msg:'Sounds interesting, can you send pricing info?', status:'unread' },
      { name:'Ahmad Zul', company:'SEDC', channel:'Email', msg:'Please remove me, tidak berminat', status:'unread', unsub:true },
      { name:'Tan Wei', company:'HSL', channel:'WA', msg:'Yes interested! When can you do site visit?', status:'unread', hot:true },
      { name:'David Wong', company:'IJM', channel:'WA', msg:'Can you do industrial areas in Demak?', status:'unread' },
      { name:'Nurul Aina', company:'SEB', channel:'WA', msg:'Apa pakej bulanan? Boleh quotation?', status:'read' },
      { name:'James Ong', company:'Sarawak Plaza', channel:'Email', msg:'Send company profile and certifications', status:'handled' },
      { name:'Mohd Salleh', company:'MBKS', channel:'Email', msg:'Forwarding to our procurement unit', status:'handled' },
    ]});
    console.log('Seeded 7 replies');
  }

  // Client portal user
  const clientExists = await prisma.user.findUnique({ where: { email: 'client@gadong.my' } });
  if (!clientExists) {
    await prisma.user.create({
      data: { email: 'client@gadong.my', password: await bcrypt.hash('gadong123', 10), name: 'Gadong Squad Client', role: 'client', bizId: 'GS' }
    });
    console.log('Created client user: client@gadong.my / gadong123');
  }

  // Seed leads
  const leadCount = await prisma.lead.count();
  if (leadCount === 0) {
    const campaigns = await prisma.campaign.findMany();
    const gsId = campaigns.find(c => c.bizId === 'GS' && c.name === 'Kuching Q2')?.id;
    const kvId = campaigns.find(c => c.bizId === 'KV')?.id;
    const gbId = campaigns.find(c => c.bizId === 'GB' && c.name === 'Contractors')?.id;
    const seId = campaigns.find(c => c.bizId === 'SE')?.id;

    await prisma.lead.createMany({ data: [
      { campaignId: gsId, name:'Ahmad Razali', company:'Naim Holdings', title:'Facilities Manager', score:8, status:'hot', lang:'EN', channels:['email','wa'], last:'2h ago' },
      { campaignId: gsId, name:'Sarah Lim', company:'Maybank KCH', title:'Property Manager', score:7, status:'replied', lang:'EN', channels:['email','email_opened','wa'], last:'5h ago' },
      { campaignId: gsId, name:'Tan Wei Liang', company:'HSL Construction', title:'GM Operations', score:9, status:'hot', lang:'EN', channels:['email','email_opened','wa'], last:'1h ago' },
      { campaignId: gsId, name:'David Wong', company:'IJM Corporation', title:'Head of Procurement', score:6, status:'replied', lang:'EN', channels:['email','wa'], last:'1d ago' },
      { campaignId: gsId, name:'Nurul Aina', company:'SEB', title:'Admin Executive', score:4, status:'opened', lang:'MS', channels:['email','email_opened'], last:'3h ago' },
      { campaignId: gsId, name:'James Ong', company:'Sarawak Plaza', title:'Building Manager', score:5, status:'personalizing', lang:'EN', channels:['email'], last:'12h ago' },
      { campaignId: gsId, name:'Mohd Salleh', company:'MBKS', title:'Director of Works', score:7, status:'replied', lang:'MS', channels:['email','wa'], last:'2d ago' },
      { campaignId: kvId, name:'Lina Abdullah', company:'Sarawak Tourism', title:'Head of Marketing', score:8, status:'hot', lang:'EN', channels:['email','email_opened','wa'], last:'3h ago' },
      { campaignId: kvId, name:'Robert Lee', company:'DBKU', title:'Communications Director', score:6, status:'replied', lang:'EN', channels:['email','wa'], last:'1d ago' },
      { campaignId: kvId, name:'Farah Daud', company:'Sarawak Energy', title:'Corporate Affairs', score:5, status:'opened', lang:'MS', channels:['email','email_opened'], last:'6h ago' },
      { campaignId: gbId, name:'Kevin Chong', company:'Hock Seng Lee', title:'Project Director', score:8, status:'hot', lang:'EN', channels:['email','wa'], last:'4h ago' },
      { campaignId: gbId, name:'Ali Hassan', company:'Cahya Mata Sarawak', title:'Procurement Manager', score:6, status:'replied', lang:'MS', channels:['email','wa'], last:'2d ago' },
      { campaignId: gbId, name:'Patricia Sim', company:'Ibraco Berhad', title:'Development Manager', score:5, status:'opened', lang:'EN', channels:['email','email_opened'], last:'1d ago' },
      { campaignId: seId, name:'Dr. Zainab', company:'UNIMAS', title:'Head of Faculty', score:7, status:'replied', lang:'EN', channels:['email','wa'], last:'5h ago' },
      { campaignId: seId, name:'Prof. Liew', company:'UITM Sarawak', title:'Dean', score:6, status:'opened', lang:'EN', channels:['email','email_opened'], last:'1d ago' },
    ]});
    console.log('Seeded 15 leads');
  }

  // Default settings
  await prisma.appSettings.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} });

  // Seed activity
  const activityCount = await prisma.activity.count();
  if (activityCount === 0) {
    await prisma.activity.createMany({ data: [
      { color:'green',  msg:'Campaign "Kuching Q2" launched — 2,400 leads queued', tag:'Campaigns' },
      { color:'amber',  msg:'Tan Wei Liang (HSL Construction) scored 9/10 — hot lead', tag:'Leads' },
      { color:'blue',   msg:'Sarah Lim (Maybank KCH) replied to email sequence', tag:'Leads' },
      { color:'green',  msg:'Lina Abdullah (Sarawak Tourism) marked as meeting booked', tag:'Leads' },
      { color:'amber',  msg:'Campaign "Developers KCH" submitted for approval', tag:'Campaigns' },
      { color:'blue',   msg:'Ahmad Razali (Naim Holdings) opened email — score 8/10', tag:'Leads' },
      { color:'green',  msg:'Campaign "KOBIS Video GLCs" resumed', tag:'Campaigns' },
      { color:'red',    msg:'Ahmad Zul (SEDC) unsubscribed from sequence', tag:'Leads' },
      { color:'blue',   msg:'Kevin Chong (Hock Seng Lee) replied via WhatsApp', tag:'Leads' },
      { color:'green',  msg:'Campaign "Contractors" — 362 leads processed', tag:'Campaigns' },
      { color:'amber',  msg:'David Wong (IJM Corporation) replied — follow up needed', tag:'Leads' },
      { color:'blue',   msg:'SendGrid connected — email delivery active', tag:'System' },
      { color:'green',  msg:'WATI WhatsApp connected — sequences live', tag:'System' },
      { color:'amber',  msg:'Nurul Aina (SEB) opened email but no reply', tag:'Leads' },
      { color:'green',  msg:'Dr. Zainab (UNIMAS) replied — high interest', tag:'Leads' },
    ]});
    console.log('Seeded 15 activity entries');
  }

  console.log('Seed complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
