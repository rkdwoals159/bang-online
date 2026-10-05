import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../..');
createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost:5184').pathname;
 let file;
 if(path==='/'||path==='/index.html')file=resolve(directory,'index.html');
 else if(['/scene.css','/scene.js'].includes(path))file=resolve(directory,path.slice(1));
 else if(/^\/apps\/site\/public\/assets\/cards\/(playing|characters|roles)\/[a-z0-9_]+\.png$/.test(path))file=resolve(root,'.'+path);
 else {res.writeHead(404);res.end();return;}
 try{res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.png')?'image/png':'text/html; charset=utf-8');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
}).listen(5184,'localhost',()=>console.log('Game scene prototype: http://localhost:5184'));

