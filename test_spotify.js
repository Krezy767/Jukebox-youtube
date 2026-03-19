require('dotenv').config();
const axios = require('axios');
const querystring = require('querystring');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

console.log('Client ID:', CLIENT_ID ? 'Found (starts with ' + CLIENT_ID.slice(0,8) + '...)' : 'NOT SET');
console.log('Client Secret:', CLIENT_SECRET ? 'Found' : 'NOT SET');

async function testAuth() {
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({ grant_type: 'client_credentials' }),
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    console.log('\n✅ Spotify credentials are VALID');
    console.log('Token type:', response.data.token_type);
  } catch (err) {
    console.log('\n❌ Spotify credentials INVALID:');
    console.log(err.response?.data || err.message);
  }
}

testAuth();
