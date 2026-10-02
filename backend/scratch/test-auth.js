const http = require('http');

const data = JSON.stringify({ email: 'admin@orbitmesh.com', password: 'supersecret123' });

const options = {
  hostname: 'localhost',
  port: 4000,
  path: '/api/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
  },
};

const req = http.request(options, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', res.headers);
    console.log('Body:', body);
    
    // Test authenticated route
    const authData = JSON.parse(body);
    const options2 = {
      hostname: 'localhost',
      port: 4000,
      path: '/api/auth/me',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authData.accessToken}`
      }
    };
    http.request(options2, res2 => {
      let body2 = '';
      res2.on('data', d => body2 += d);
      res2.on('end', () => {
        console.log('GET /me Status:', res2.statusCode);
        console.log('GET /me Body:', body2);
      });
    }).end();
  });
});

req.write(data);
req.end();
