'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const graphicalAssets={NOVNC_JS:'vendor/novnc.js',GRAPHICAL_VIEWER_JS:'src/graphical-viewer.js'};
function buildHTML(entry,assets) {
  let html=fs.readFileSync(path.join(root,'src',entry),'utf8');
  for(const [name,file] of Object.entries(assets)) {
    let source=fs.readFileSync(path.join(root,file),'utf8').replace(/^\/\/# sourceMappingURL=.*$/mg,'');
    if(name!=='XTERM_CSS')source=source.replace(/<\/script/gi,'<\\/script');
    html=html.replace('/* '+name+' */',()=>source);
  }
  if(Buffer.byteLength(html)>2*1024*1024)throw Error(entry+' exceeds host HTML limit');
  fs.writeFileSync(path.join(root,entry),html);
  console.log('Built offline '+entry+':',Buffer.byteLength(html),'bytes');
}
buildHTML('workbench.html',{XTERM_CSS:'node_modules/@xterm/xterm/css/xterm.css',XTERM_JS:'node_modules/@xterm/xterm/lib/xterm.js',FIT_JS:'node_modules/@xterm/addon-fit/lib/addon-fit.js',SEARCH_JS:'node_modules/@xterm/addon-search/lib/addon-search.js',...graphicalAssets,BRIDGE_JS:'vendor/plugin-workbench-client.js',RELAY_PROFILE_JS:'relay/profile.js',APP_JS:'src/workbench.js'});
buildHTML('viewer.html',{...graphicalAssets,VIEWER_JS:'src/viewer.js'});
for(const name of ['xterm','addon-fit','addon-search'])fs.copyFileSync(path.join(root,'node_modules/@xterm',name,'LICENSE'),path.join(root,'vendor',name+'-LICENSE'));
