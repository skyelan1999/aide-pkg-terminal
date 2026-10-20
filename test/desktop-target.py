"""Synthetic X11 target used only in isolated VNC/RDP acceptance tests."""
import ctypes as c, json, os
x=c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[c.c_char_p];x.XOpenDisplay.restype=c.c_void_p
d=x.XOpenDisplay(None)
if not d:raise RuntimeError('test display unavailable')
x.XDefaultRootWindow.argtypes=[c.c_void_p];x.XDefaultRootWindow.restype=c.c_ulong
x.XCreateSimpleWindow.argtypes=[c.c_void_p,c.c_ulong,c.c_int,c.c_int,c.c_uint,c.c_uint,c.c_uint,c.c_ulong,c.c_ulong];x.XCreateSimpleWindow.restype=c.c_ulong
w=x.XCreateSimpleWindow(d,x.XDefaultRootWindow(d),0,0,800,600,0,0,0x183658)
for name,args in [('XStoreName',[c.c_void_p,c.c_ulong,c.c_char_p]),('XSelectInput',[c.c_void_p,c.c_ulong,c.c_long]),('XMapWindow',[c.c_void_p,c.c_ulong]),('XSetInputFocus',[c.c_void_p,c.c_ulong,c.c_int,c.c_ulong]),('XFlush',[c.c_void_p]),('XNextEvent',[c.c_void_p,c.c_void_p]),('XSetWindowBackground',[c.c_void_p,c.c_ulong,c.c_ulong]),('XClearWindow',[c.c_void_p,c.c_ulong])]:getattr(x,name).argtypes=args
x.XStoreName(d,w,b'Aide isolated desktop fixture');x.XSelectInput(d,w,(1<<0)|(1<<1)|(1<<2)|(1<<3)|(1<<6)|(1<<15));x.XMapWindow(d,w);x.XSetInputFocus(d,w,1,0);x.XFlush(d)
print(json.dumps({'ready':True}),flush=True)
e=c.create_string_buffer(192)
while True:
 x.XNextEvent(d,e);kind=c.c_int.from_buffer(e,0).value
 if kind in (2,3,4,5,6):
  print(json.dumps({'type':kind,'x':c.c_int.from_buffer(e,64).value,'y':c.c_int.from_buffer(e,68).value,'code':c.c_uint.from_buffer(e,84).value,'state':c.c_uint.from_buffer(e,80).value}),flush=True)
  if kind==4:x.XSetWindowBackground(d,w,0x276b45);x.XClearWindow(d,w);x.XFlush(d)
