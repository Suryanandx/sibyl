// CloudFront viewer-request function (cloudfront-js-2.0).
// 1. Any host other than the main domain gets a permanent redirect to it.
// 2. Folder URLs serve their index.html (S3 behind CloudFront doesn't do this itself).
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : "";
  var uri = request.uri;

  if (host !== "${apex}") {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: "https://${apex}" + uri } }
    };
  }

  if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
  } else if (uri.split("/").pop().indexOf(".") === -1) {
    request.uri = uri + "/index.html";
  }
  return request;
}
