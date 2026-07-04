(() => {
  "use strict";

  const canvas = document.querySelector("#space");
  const reset = document.querySelector("#reset");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  const fail = (text) =>
    document.body.insertAdjacentHTML(
      "beforeend",
      `<p class="error">${text}</p>`,
    );
  if (!gl) return fail("WebGL 2 is required.");

  const D = [512, 512],
    R = [256, 128];
  const DC = D[0] * D[1],
    RC = R[0] * R[1];
  const linear = Boolean(gl.getExtension("OES_texture_float_linear"));
  const sampling = linear
    ? `
    vec2 tableCoord(vec2 uv,ivec2 n){
      return (.5+clamp(uv,0.,1.)*vec2(n-1))/vec2(n);
    }
    float sampleDeflection(vec2 uv){
      return texture(deflectionTable,tableCoord(uv,DS)).r;
    }
    float sampleRadius(vec2 uv){
      return texture(radiusTable,tableCoord(uv,RS)).r;
    }`
    : `
    float sampleDeflection(vec2 uv){
      vec2 p=clamp(uv,0.,1.)*vec2(DS-1),f=fract(p);
      ivec2 a=ivec2(floor(p)),b=min(a+1,DS-1);
      return mix(mix(texelFetch(deflectionTable,a,0).r,
                     texelFetch(deflectionTable,ivec2(b.x,a.y),0).r,f.x),
                 mix(texelFetch(deflectionTable,ivec2(a.x,b.y),0).r,
                     texelFetch(deflectionTable,b,0).r,f.x),f.y);
    }
    float sampleRadius(vec2 uv){
      vec2 p=clamp(uv,0.,1.)*vec2(RS-1),f=fract(p);
      ivec2 a=ivec2(floor(p)),b=min(a+1,RS-1);
      return mix(mix(texelFetch(radiusTable,a,0).r,
                     texelFetch(radiusTable,ivec2(b.x,a.y),0).r,f.x),
                 mix(texelFetch(radiusTable,ivec2(a.x,b.y),0).r,
                     texelFetch(radiusTable,b,0).r,f.x),f.y);
    }`;

  const vertex = `#version 300 es
    precision highp float;
    uniform vec2 resolution,pan,jitter;
    uniform vec3 camera;
    flat out vec3 radial;
    flat out float observerU,lapse;
    out vec3 ray;
    void main(){
      vec2 p=vec2[3](vec2(-1),vec2(3,-1),vec2(-1,3))[gl_VertexID];
      gl_Position=vec4(p,0,1);
      float y=camera.x,q=camera.y;
      radial=vec3(sin(y)*cos(q),sin(q),cos(y)*cos(q));
      observerU=.5/camera.z;lapse=sqrt(1.-observerU);
      vec3 f=-radial,r=normalize(cross(f,vec3(0,1,0))),u=cross(r,f);
      vec2 s=vec2(p.x*resolution.x/resolution.y,p.y)-pan+2.*jitter/resolution.y;
      ray=f+.62*(s.x*r+s.y*u);
    }`;
  const fragment = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    flat in vec3 radial;
    flat in float observerU,lapse;
    in vec3 ray;
    uniform sampler2D deflectionTable,radiusTable;
    uniform vec2 resolution,pan;
    uniform float time;
    out vec4 color;
    const float PI=3.141592653589793,MU=4./27.,EH=.5,RI=1.5,RO=2.8;
    const float UO=EH/RO,CULL=.8*UO*UO*(1.-UO),GUARD=.85*UO*UO*(1.-UO);
    const ivec2 DS=ivec2(512),RS=ivec2(256,128);
    ${sampling}
    float apsis(float e){
      return 1./3.+2./3.*sin(asin(clamp(2.*e/MU-1.,-1.,1.))/3.);
    }
    float du(float e){
      return e<MU?.5-sqrt(max(-log(max(1.-e/MU,1e-30))/50.,0.)):
                  .5+sqrt(max(-log(max(1.-MU/e,1e-30))/50.,0.));
    }
    float dv(float e,float u){
      if(e>MU){
        float x=u<2./3.?-sqrt(2./3.-u):sqrt(u-2./3.);
        return (sqrt(2./3.)+x)/(sqrt(2./3.)+sqrt(1./3.));
      }
      return 1.-sqrt(max(1.-u/apsis(e),0.));
    }
    float deflect(float e,float u){
      return sampleDeflection(vec2(du(e),dv(e,u)));
    }
    float radius(float e,float p){
      float bound=(1.+e)/(1./3.+2.*e*sqrt(e));
      return sampleRadius(vec2(1./(1.+6.*e),p/bound));
    }
    float pulse(float a,float b,float x,float w){
      w=max(w,1e-6);x-=w*.5;
      return max(0.,(min(x+w,b)-max(x,a))/w);
    }
    float hash21(vec2 p){
      p=fract(p*vec2(123.34,456.21));
      p+=dot(p,p+45.32);
      return fract(p.x*p.y);
    }
    float noise(vec2 p){
      vec2 i=floor(p),f=fract(p);
      f=f*f*(3.-2.*f);
      return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x),
                 mix(hash21(i+vec2(0,1)),hash21(i+1.),f.x),f.y);
    }
    float fbm(vec2 p){
      float n=0.,a=.55;
      mat2 m=mat2(1.62,1.18,-1.18,1.62);
      for(int i=0;i<4;i++){n+=a*noise(p);p=m*p+7.13;a*=.48;}
      return n;
    }
    vec3 plasma(float u,float opacity,float height,float orbitalPhase){
      float r=EH/max(u,1e-5);
      float q=clamp((r-RI)/(RO-RI),0.,1.);
      // Keplerian shear: the inner gas completes an orbit much faster.
      float spin=time*(2.3/pow(r,1.5));
      // Screen-space phase avoids the parity reversal of secondary lens images.
      // Subtracting spin makes every visible feature advance counterclockwise.
      float angle=orbitalPhase-spin;
      vec2 orbit=vec2(cos(angle),sin(angle));
      vec2 flow=orbit*5.2+
                vec2(r*7.5+height*9.,r*20.-time*.17);
      float coarse=fbm(flow);
      float fine=fbm(orbit*18.+
                     vec2(-r*9.+height*21.,
                          r*72.+coarse*4.-time*.65));
      float filaments=smoothstep(.28,.92,.52*coarse+.72*fine);
      float knots=fbm(orbit*2.1+vec2(-time*.08,r*5.7));
      float rings=.68+.32*sin(r*82.+coarse*8.-time*.8);
      float density=mix(.34,1.08,filaments)*mix(.86,1.15,rings);
      density*=mix(.72,1.32,smoothstep(.22,.86,knots));
      density*=exp(-height*height*2.2);
      float heat=pow(1.-q,.42);
      float hot=pow(heat,2.2)*mix(.52,1.48,fine)*mix(.8,1.25,knots);
      vec3 copper=vec3(1.0,.19,.025);
      vec3 amber=vec3(1.0,.54,.16);
      vec3 white=vec3(1.0,.93,.72);
      vec3 tint=mix(copper,amber,smoothstep(0.,.78,heat));
      tint=mix(tint,white,smoothstep(.48,1.08,hot));
      float beaming=.78+.32*sin(orbitalPhase+1.1);
      return tint*opacity*density*(1.15+5.8*hot)*beaming;
    }
    vec3 trace(vec3 local,float height,float orbitalPhase){
      float lr=dot(local,radial);
      vec3 d=local+lr*(lapse-1.)*radial;
      float delta=acos(clamp(dot(radial,normalize(d)),-1.,1.));
      float ud=-observerU/tan(delta),e=ud*ud+observerU*observerU*(1.-observerU);
      if(observerU<UO&&e<CULL||e<MU&&observerU>2./3.)return vec3(0);

      vec3 n=cross(radial,d);
      float nl=length(n);if(nl<1e-6)return vec3(0);n/=nl;
      vec3 tangent=cross(n,radial),axis=cross(vec3(0,1,0),n);
      float al=length(axis);if(al<1e-6)return vec3(0);axis/=al;
      if(dot(axis,tangent)<0.)axis=-axis;
      float alpha=acos(clamp(dot(radial,axis),-1.,1.));

      float a=deflect(e,observerU),aa=deflect(e,e<MU?apsis(e):1.);
      float side=ud>=0.?1.:-1.,pa=aa+PI*.5;
      float p=a+(side>0.?PI-delta:delta)+side*alpha;
      float p0=mod(p,PI),c0=radius(e,p0);
      bool v0=p0<pa;
      float rs=side*(c0-observerU);
      v0=v0&&(rs>1e-3||(rs>-1e-3&&alpha<delta));
      float u0=v0?c0:-1.;

      float p1=mod(2.*pa-p,PI),c1=radius(e,p1);
      bool v1=e<MU&&side>0.&&p1<pa;
      float u1=v1?c1:-1.;
      float w0=min(fwidth(c0),fwidth(u0<0.?u1:u0));
      float w1=min(fwidth(c1),fwidth(u1<0.?u0:u1));
      float o0=v0?pulse(UO,EH/RI,u0,w0):0.;
      float o1=v1?pulse(UO,EH/RI,u1,w1):0.;
      if(observerU<UO&&e<GUARD)return vec3(0);

      vec3 light=vec3(0);
      if(o0>0.)light+=plasma(u0,o0,height,orbitalPhase);
      if(o1>0.)light+=plasma(u1,o1,height,orbitalPhase);

      // A low-energy sheath gives the optically thick surface a soft edge
      // without changing the solved geodesic silhouette.
      float halo0=v0?pulse(UO*.965,(EH/RI)*1.015,u0,max(w0,.006)):0.;
      float halo1=v1?pulse(UO*.965,(EH/RI)*1.015,u1,max(w1,.006)):0.;
      light+=vec3(1.,.25,.045)*.11*(halo0+halo1);
      return light;
    }
    vec3 stars(vec2 p){
      vec2 cell=floor(p*resolution/3.);
      float h=hash21(cell);
      float star=smoothstep(.9978,1.,h);
      float twinkle=.45+.55*hash21(cell+19.7);
      return vec3(.42,.54,.68)*star*twinkle*.42;
    }
    void main(){
      vec3 v=normalize(ray);
      vec2 center=resolution*.5+pan*resolution.y*.5;
      float orbitalPhase=atan(gl_FragCoord.y-center.y,
                              gl_FragCoord.x-center.x);
      // A smooth Gaussian density profile sampled through the disk atmosphere.
      // Every layer uses the original geodesic solver; only optical depth varies.
      vec3 hdr=trace(v,0.,orbitalPhase)*.34;
      hdr+=trace(normalize(ray+vec3(0,.0042,0)), .42,orbitalPhase)*.245;
      hdr+=trace(normalize(ray-vec3(0,.0042,0)),-.42,orbitalPhase)*.245;
      hdr+=trace(normalize(ray+vec3(0,.0084,0)), .84,orbitalPhase)*.13;
      hdr+=trace(normalize(ray-vec3(0,.0084,0)),-.84,orbitalPhase)*.13;
      hdr+=stars(gl_FragCoord.xy);
      vec3 mapped=1.-exp(-hdr*.72);
      mapped=pow(mapped,vec3(.82));
      float grain=hash21(gl_FragCoord.xy)-.5;
      mapped+=grain*(1.-smoothstep(.05,.8,max(mapped.r,max(mapped.g,mapped.b))))*.012;
      color=vec4(max(mapped,0.),1);
    }
  `;
  const postVertex = `#version 300 es
    precision highp float;
    out vec2 uv;
    void main(){
      vec2 p=vec2[3](vec2(-1),vec2(3,-1),vec2(-1,3))[gl_VertexID];
      gl_Position=vec4(p,0,1);
      uv=p*.5+.5;
    }`;
  const postFragment = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    in vec2 uv;
    uniform sampler2D scene;
    uniform vec2 resolution;
    out vec4 color;
    vec3 fire(vec2 at){
      return max(texture(scene,at).rgb-vec3(.055),0.);
    }
    void main(){
      vec2 px=1./resolution;
      vec3 base=texture(scene,uv).rgb;
      // Optical scattering inside the hot gas removes sub-pixel geometric
      // separations while leaving the original lensing solution underneath.
      vec3 meld=base*.28;
      meld+=(texture(scene,uv+vec2( 2.,0.)*px).rgb
            +texture(scene,uv+vec2(-2.,0.)*px).rgb
            +texture(scene,uv+vec2(0., 2.)*px).rgb
            +texture(scene,uv+vec2(0.,-2.)*px).rgb)*.105;
      meld+=(texture(scene,uv+vec2( 5., 5.)*px).rgb
            +texture(scene,uv+vec2(-5., 5.)*px).rgb
            +texture(scene,uv+vec2( 5.,-5.)*px).rgb
            +texture(scene,uv+vec2(-5.,-5.)*px).rgb)*.075;
      float luminous=smoothstep(.018,.34,max(meld.r,max(meld.g,meld.b)));
      base=mix(base,meld,luminous*.68);
      vec3 near=fire(uv)*.20;
      near+=(fire(uv+vec2( 4.,0.)*px)+fire(uv+vec2(-4.,0.)*px)
            +fire(uv+vec2(0., 4.)*px)+fire(uv+vec2(0.,-4.)*px))*.105;
      near+=(fire(uv+vec2( 5., 5.)*px)+fire(uv+vec2(-5., 5.)*px)
            +fire(uv+vec2( 5.,-5.)*px)+fire(uv+vec2(-5.,-5.)*px))*.066;
      vec3 wide=(fire(uv+vec2( 10.,0.)*px)+fire(uv+vec2(-10.,0.)*px)
                +fire(uv+vec2(0., 10.)*px)+fire(uv+vec2(0.,-10.)*px))*.058;
      wide+=(fire(uv+vec2( 17., 9.)*px)+fire(uv+vec2(-17., 9.)*px)
            +fire(uv+vec2( 17.,-9.)*px)+fire(uv+vec2(-17.,-9.)*px))*.034;
      vec3 glow=(near+wide)*vec3(1.08,.72,.46);
      color=vec4(1.-(1.-base)*exp(-glow*1.72),1);
    }`;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    return fail(gl.getProgramInfoLog(program));
  const postProgram = gl.createProgram();
  gl.attachShader(postProgram, compile(gl.VERTEX_SHADER, postVertex));
  gl.attachShader(postProgram, compile(gl.FRAGMENT_SHADER, postFragment));
  gl.linkProgram(postProgram);
  if (!gl.getProgramParameter(postProgram, gl.LINK_STATUS))
    return fail(gl.getProgramInfoLog(postProgram));

  const texture = (data, [w, h], unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      linear ? gl.LINEAR : gl.NEAREST,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      linear ? gl.LINEAR : gl.NEAREST,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
    return t;
  };

  (async () => {
    const response = await fetch("cache/geodesics.bin");
    if (!response.ok) throw Error("Could not load the geodesic cache.");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== (DC + RC) * 4)
      throw Error("Invalid geodesic cache.");
    const cache = new Float32Array(buffer);

    gl.useProgram(program);
    texture(cache.subarray(0, DC), D, 0);
    texture(cache.subarray(DC), R, 1);
    gl.uniform1i(gl.getUniformLocation(program, "deflectionTable"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "radiusTable"), 1);
    const u = Object.fromEntries(
      ["resolution", "pan", "jitter", "camera", "time"].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );
    gl.useProgram(postProgram);
    gl.uniform1i(gl.getUniformLocation(postProgram, "scene"), 2);
    const postResolution = gl.getUniformLocation(postProgram, "resolution");

    const defaults = { yaw: 0, pitch: 0.2, distance: 7.2, panX: 0, panY: 0 };
    const view = { ...defaults },
      pointers = new Map();
    const accTexture = gl.createTexture(),
      accBuffer = gl.createFramebuffer();
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let gesture,
      frame,
      timer,
      scale;
    const finalScale = () =>
      Math.max(
        0.75,
        Math.min(
          Math.max(devicePixelRatio || 1, 1.15),
          1.4,
          maxSize / innerWidth,
          maxSize / innerHeight,
          Math.sqrt(4500000 / (innerWidth * innerHeight)),
        ),
      );

    const resize = () => {
      const w = Math.round(innerWidth * scale),
        h = Math.round(innerHeight * scale);
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, accTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        w,
        h,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, accBuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        accTexture,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw Error("Could not create the accumulation buffer.");
    };
    const draw = (now) => {
      resize();
      gl.bindFramebuffer(gl.FRAMEBUFFER, accBuffer);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(u.resolution, canvas.width, canvas.height);
      gl.uniform2f(u.pan, view.panX, view.panY);
      gl.uniform2f(u.jitter, 0, 0);
      gl.uniform3f(u.camera, view.yaw, view.pitch, view.distance);
      gl.uniform1f(u.time, now * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(postProgram);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, accTexture);
      gl.uniform2f(postResolution, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frame = requestAnimationFrame(draw);
    };
    const quality = (high) => {
      scale = high ? finalScale() : Math.min(devicePixelRatio || 1, 0.85);
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const moving = () => {
      quality(false);
      clearTimeout(timer);
      timer = setTimeout(() => quality(true), 120);
    };
    const readGesture = () => {
      if (pointers.size < 2) return null;
      const [a, b] = [...pointers.values()];
      return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        distance: Math.hypot(a.x - b.x, a.y - b.y),
      };
    };

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      gesture = readGesture();
    });
    canvas.addEventListener("pointermove", (e) => {
      const old = pointers.get(e.pointerId);
      if (!old) return;
      const point = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, point);
      const next = readGesture();
      if (next && gesture) {
        view.distance = Math.max(
          3,
          Math.min(
            12,
            (view.distance * gesture.distance) / Math.max(next.distance, 1),
          ),
        );
        view.panX += ((next.x - gesture.x) * 2) / innerHeight;
        view.panY -= ((next.y - gesture.y) * 2) / innerHeight;
        gesture = next;
      } else if (!next) {
        const dx = point.x - old.x,
          dy = point.y - old.y;
        if (e.shiftKey || e.button === 1 || e.button === 2) {
          view.panX += (dx * 2) / innerHeight;
          view.panY -= (dy * 2) / innerHeight;
        } else {
          view.yaw -= dx * 0.008;
          view.pitch = Math.max(-1.42, Math.min(1.42, view.pitch + dy * 0.006));
        }
      }
      moving();
    });
    const release = (e) => {
      pointers.delete(e.pointerId);
      gesture = readGesture();
      clearTimeout(timer);
      quality(true);
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        view.distance = Math.max(
          3,
          Math.min(12, view.distance * Math.exp(e.deltaY * 0.001)),
        );
        moving();
      },
      { passive: false },
    );
    reset.addEventListener("click", () => {
      Object.assign(view, defaults);
      quality(true);
    });
    addEventListener("resize", () => quality(true), { passive: true });
    quality(true);
  })().catch((error) => {
    console.error(error);
    fail("The black hole renderer could not start.");
  });
})();
