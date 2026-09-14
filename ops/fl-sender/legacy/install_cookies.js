const fs = require('fs');
const {CryptoService}=require('/app/apps/api/dist/crypto.service.js');
const {Pool}=require('/app/node_modules/pg');
(async()=>{
  const cookies=JSON.parse(fs.readFileSync('/tmp/fl_cookies_new.json','utf8'));
  const enc=new CryptoService().encrypt(JSON.stringify(cookies));
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  await pool.query(`INSERT INTO settings(key,encrypted_value,updated_at) VALUES('fl_cookies',$1,now())
    ON CONFLICT(key) DO UPDATE SET encrypted_value=$1,updated_at=now()`,[enc]);
  const r=await pool.query("SELECT encrypted_value FROM settings WHERE key='fl_cookies'");
  const back=JSON.parse(new CryptoService().decrypt(r.rows[0].encrypted_value));
  console.log('stored', back.length, 'cookies; has pwd:', back.some(c=>c.name==='pwd'), '; PHPSESSID len:', (back.find(c=>c.name==='PHPSESSID')||{}).value?.length);
  await pool.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
