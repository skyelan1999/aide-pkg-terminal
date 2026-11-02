'use strict';
// RFC 854/855 NVT, RFC 1073 NAWS and RFC 1091 terminal type. The codec owns no
// socket: exactly the same state machine is used on direct TCP and TLS relay.
const IAC=255, DONT=254, DO=253, WONT=252, WILL=251, SB=250, SE=240;
const OPT={BINARY:0,ECHO:1,SGA:3,TTYPE:24,NAWS:31};
class Telnet {
  constructor(write, output, {cols=100,rows=30,terminal='xterm-256color'}={}) {
    this.write=write;this.output=output;this.cols=cols;this.rows=rows;
    if(!/^[A-Za-z0-9_.+-]{1,64}$/.test(terminal))throw Error('Invalid Telnet terminal type');
    this.terminal=terminal;this.state='data';this.command=0;this.sub=[];
    this.local=new Set();this.remote=new Set();this.offered=new Set();this.requested=new Set();
    this.refusedLocal=new Set();this.refusedRemote=new Set();this.cr=false;this.closed=false;
  }
  start(){for(const o of [OPT.TTYPE,OPT.NAWS,OPT.SGA]){this.offered.add(o);this.control(WILL,o);}this.requested.add(OPT.SGA);this.control(DO,OPT.SGA);}
  control(command,option){if(!this.closed)this.write(Buffer.from([IAC,command,option]));}
  subneg(option,bytes){const escaped=[];for(const b of bytes){escaped.push(b);if(b===IAC)escaped.push(IAC);}this.write(Buffer.from([IAC,SB,option,...escaped,IAC,SE]));}
  negotiate(command,option){
    if(command===DO){
      if([OPT.BINARY,OPT.SGA,OPT.TTYPE,OPT.NAWS].includes(option)){
        if(!this.local.has(option)){this.local.add(option);if(!this.offered.delete(option))this.control(WILL,option);if(option===OPT.NAWS)this.window();}
      }else if(!this.refusedLocal.has(option)){this.refusedLocal.add(option);this.control(WONT,option);}
    }else if(command===DONT){if(this.local.delete(option))this.control(WONT,option);this.offered.delete(option);this.refusedLocal.delete(option);}
    else if(command===WILL){
      if([OPT.BINARY,OPT.ECHO,OPT.SGA].includes(option)){
        if(!this.remote.has(option)){this.remote.add(option);if(!this.requested.delete(option))this.control(DO,option);}
      }else if(!this.refusedRemote.has(option)){this.refusedRemote.add(option);this.control(DONT,option);}
    }else if(command===WONT){if(this.remote.delete(option))this.control(DONT,option);this.requested.delete(option);this.refusedRemote.delete(option);}
  }
  receive(chunk){
    if(this.closed)return;
    const data=[];
    const emit=b=>{if(this.remote.has(OPT.BINARY)){if(this.cr){data.push(13);this.cr=false;}data.push(b);return;}if(this.cr){data.push(13);this.cr=false;if(b===0)return;if(b===10){data.push(10);return;}}if(b===13)this.cr=true;else data.push(b);};
    for(const b of chunk){
      switch(this.state){
        case 'data':if(b===IAC)this.state='iac';else emit(b);break;
        case 'iac':if(b===IAC){emit(b);this.state='data';}else if([DO,DONT,WILL,WONT].includes(b)){this.command=b;this.state='option';}else if(b===SB){this.sub=[];this.state='sub';}else this.state='data';break;
        case 'option':this.negotiate(this.command,b);this.state='data';break;
        case 'sub':if(b===IAC)this.state='sub-iac';else this.sub.push(b);break;
        case 'sub-iac':if(b===SE){this.submessage();this.sub=[];this.state='data';}else if(b===IAC){this.sub.push(IAC);this.state='sub';}else{this.sub=[];this.state='data';}break;
      }
      if(this.sub.length>4096)throw Error('Telnet subnegotiation exceeds 4096 bytes');
    }
    if(data.length)this.output(Buffer.from(data));
  }
  submessage(){if(this.sub[0]===OPT.TTYPE&&this.sub[1]===1&&this.local.has(OPT.TTYPE))this.subneg(OPT.TTYPE,Buffer.concat([Buffer.from([0]),Buffer.from(this.terminal,'ascii')]));}
  encode(data){
    const out=[];for(let i=0;i<data.length;i++){const b=data[i];if(b===IAC)out.push(IAC,IAC);else if(!this.local.has(OPT.BINARY)&&b===13){out.push(13,data[i+1]===10?10:0);if(data[i+1]===10)i++;}else if(!this.local.has(OPT.BINARY)&&b===10)out.push(13,10);else out.push(b);}return Buffer.from(out);
  }
  resize(cols,rows){this.cols=cols;this.rows=rows;if(this.local.has(OPT.NAWS))this.window();}
  window(){const data=Buffer.alloc(4);data.writeUInt16BE(this.cols);data.writeUInt16BE(this.rows,2);this.subneg(OPT.NAWS,data);}
  finish(){if(this.cr){this.output(Buffer.from([13]));this.cr=false;}this.closed=true;this.sub=[];}
  get remoteEcho(){return this.remote.has(OPT.ECHO);}
}
module.exports={Telnet,OPT,IAC,DO,DONT,WILL,WONT,SB,SE};
