/* global window */
// Starts Swagger UI for the CAPI Navigator API (FP23-F-04). Requests use the browser's session
// cookie; mutating requests get the CSRF header the API requires.
window.addEventListener('load', function () {
  window.ui = window.SwaggerUIBundle({
    url: '../openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    displayOperationId: false,
    docExpansion: 'none',
    filter: true,
    persistAuthorization: false,
    presets: [window.SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    requestInterceptor: function (req) {
      var method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        req.headers['x-capi-navigator'] = '1';
      }
      req.credentials = 'same-origin';
      return req;
    },
  });
});
