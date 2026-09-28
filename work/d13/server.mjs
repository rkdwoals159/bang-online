import { createServer } from "node:http";

const target = "http://127.0.0.61:5177/rooms/r_WFCubFK898xuLKQF-fBx-n8q/game";
const html = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>D13 360 CSS px game viewport</title>
    <style>
      html,body { margin:0; min-height:100%; background:#16221a; color:#eee; font:16px/1.4 system-ui,sans-serif; }
      main { width:100%; }
      h1 { margin:0; padding:0.5rem; font-size:1rem; }
      iframe { display:block; width:360px; height:800px; border:2px solid #d8d1b7; background:#fff; }
    </style>
  </head>
  <body>
    <main>
      <h1>앱 iframe viewport: 360 × 800 CSS px</h1>
      <iframe title="360 CSS px BANG! game view" aria-label="360 CSS px BANG! game view" src="${target}"></iframe>
    </main>
  </body>
</html>`;

createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/index.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}).listen(5180, "127.0.0.1", () => process.stdout.write("D13 viewport harness http://127.0.0.1:5180/\n"));
