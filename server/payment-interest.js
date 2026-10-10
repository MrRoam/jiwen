// 路由注册在账号认证之后；客户端只能表达当前账号的期待。
export function registerPaymentInterestRoutes(app,db){
  const count=db.prepare('SELECT COUNT(*) AS count FROM payment_interest');
  const own=db.prepare('SELECT 1 FROM payment_interest WHERE user_id=?');
  const insert=db.prepare('INSERT INTO payment_interest(user_id,created_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING');
  const snapshot=userId=>({count:count.get().count,interested:!!own.get(userId)});
  app.get('/api/payment-interest',(req,res)=>res.json(snapshot(req.user.id)));
  app.post('/api/payment-interest',(req,res)=>{
    insert.run(req.user.id,new Date().toISOString());
    res.json(snapshot(req.user.id));
  });
}
