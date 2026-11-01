// The test fakes' route for LND's GET /v2/router/track/{payment_hash}, as LND's REST gateway matches it. The gateway
// percent-decodes the request path and only then splits it on '/', so an encoded slash (%2F) is a route boundary and
// cannot sit inside a hash segment. The segment must be padded base64, standard or URL-safe, of a 32-byte hash.
// Returns the hash as hex, or null when the request does not match the route (the gateway answers 404 for that).
const STANDARD_BASE64_HASH = /^[A-Za-z0-9+/]{43}=$/;
const URL_BASE64_HASH = /^[A-Za-z0-9_-]{43}=$/;

function routeTrackRequest(requestTarget) {
  const segments = decodeURIComponent(requestTarget.split('?')[0]).split('/');
  if (segments.length !== 5 || segments.slice(0, 4).join('/') !== '/v2/router/track') {
    return null;
  }
  const segment = segments[4];
  if (!STANDARD_BASE64_HASH.test(segment) && !URL_BASE64_HASH.test(segment)) return null;
  return Buffer.from(segment, 'base64').toString('hex');
}

module.exports = { routeTrackRequest };
