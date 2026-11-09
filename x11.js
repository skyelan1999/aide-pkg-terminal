'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
function prepareX11(args,root,env=process.env){
  if(args.x11Enabled!==undefined&&typeof args.x11Enabled!=='boolean')throw Error('X11 enabled must be boolean');
  if(!args.x11Enabled)return {argv:[],env:{}};
  if(args.kind!=='ssh')throw Error('X11 requires an independent SSH device session');
  const display=String(args.x11Display||env.DISPLAY||'');
  if(!/^(?:[A-Za-z0-9_./-]*|\[[A-Fa-f0-9:]+\]):\d{1,5}(?:\.\d{1,5})?$/.test(display)||display.length>512||display.split('/').includes('..'))throw Error('Provide a valid reachable X Server DISPLAY');
  const locations=[...(env.PATH||'').split(path.delimiter),...(process.platform==='darwin'?['/opt/X11/bin']:[])];
  const xauth=locations.map(p=>path.join(p,'xauth')).find(p=>{try{return path.isAbsolute(p)&&/^[A-Za-z0-9_./-]+$/.test(p)&&fs.statSync(p).isFile()&&(fs.accessSync(p,fs.constants.X_OK),true);}catch{return false;}});
  if(!xauth)throw Error('X11 needs an existing xauth executable in the Aide runtime');
  let authority=args.managedX11Authority||args.x11AuthorityFile;
  const managed=typeof args.managedX11Authority==='string'&&path.isAbsolute(args.managedX11Authority)&&args.managedX11Authority.startsWith(path.join(os.tmpdir(),'aide-terminal-x11-'))&&path.basename(args.managedX11Authority)==='Xauthority';
  if(managed){
    try{const st=fs.statSync(authority);if(!st.isFile()||(st.mode&0o077)!==0)throw Error();}catch{throw Error('受管 Xauthority 权限无效');}
  }else if(authority){
    if(typeof authority!=='string'||path.isAbsolute(authority)||authority.split(/[\\/]/).includes('..'))throw Error('Xauthority must be a workspace-relative file');
    authority=fs.realpathSync(path.join(root,authority));
    if(authority!==root&&!authority.startsWith(root+path.sep))throw Error('Xauthority escapes workspace');
  }else authority=env.XAUTHORITY||path.join(env.HOME||'','.Xauthority');
  try{if(!path.isAbsolute(authority)||!fs.statSync(authority).isFile())throw Error();fs.accessSync(authority,fs.constants.R_OK);}catch{throw Error('Provide an existing readable Xauthority file; X11 authentication is not disabled automatically');}
  // Do not let OpenSSH silently fall back to missing/fake local auth data. The
  // helper output contains a credential: validate in memory and never return it.
  const listing=spawnSync(xauth,['-f',authority,'list',display],{encoding:'utf8',env:{...env,XAUTHORITY:authority},timeout:3000,maxBuffer:8192});
  if(listing.error||listing.status!==0||!/^\S+\s+MIT-MAGIC-COOKIE-1\s+[a-fA-F0-9]{32}\s*$/m.test(listing.stdout||''))throw Error('Xauthority has no valid MIT cookie for the selected DISPLAY');
  return {argv:['-X','-o','ForwardX11Trusted=no','-o','ForwardX11Timeout=1200','-o','XAuthLocation='+xauth],env:{DISPLAY:display,XAUTHORITY:authority}};
}
module.exports={prepareX11};
