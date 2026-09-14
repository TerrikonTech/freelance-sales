const {CryptoService}=require('/app/apps/api/dist/crypto.service.js');
const {Pool}=require('/app/node_modules/pg');
const puppeteer=require('/app/node_modules/puppeteer-core');
(async()=>{
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const r=await pool.query("SELECT encrypted_value FROM settings WHERE key='fl_cookies'");
  await pool.end();
  const cookies=JSON.parse(new CryptoService().decrypt(r.rows[0].encrypted_value));
  const browser=await puppeteer.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  try{
    const page=await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36');
    await page.setViewport({width:1512,height:900});
    await page.setCookie(...cookies);
    await page.goto('https://www.fl.ru/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await new Promise(res=>setTimeout(res,4000));
    const uid=await page.$eval('meta[name="current-uid"]',e=>e.getAttribute('content')).catch(()=>'');
    const captcha=await page.$('iframe[src*="captcha"], [class*="captcha"], input[name*="captcha"]').catch(()=>null);
    const title=await page.title();
    console.log(JSON.stringify({uid, captcha:!!captcha, title, url:page.url()}));
  } finally { await browser.close(); }
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
