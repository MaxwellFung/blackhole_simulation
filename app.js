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
    float trace(vec3 local){
      float lr=dot(local,radial);
      vec3 d=local+lr*(lapse-1.)*radial;
      float delta=acos(clamp(dot(radial,normalize(d)),-1.,1.));
      float ud=-observerU/tan(delta),e=ud*ud+observerU*observerU*(1.-observerU);
      if(observerU<UO&&e<CULL||e<MU&&observerU>2./3.)return 0.;

      vec3 n=cross(radial,d);
      float nl=length(n);if(nl<1e-6)return 0.;n/=nl;
      vec3 tangent=cross(n,radial),axis=cross(vec3(0,1,0),n);
      float al=length(axis);if(al<1e-6)return 0.;axis/=al;
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
      if(observerU<UO&&e<GUARD)return 0.;
      return 1.-(1.-o0)*(1.-o1);
    }
    void main(){float x=trace(normalize(ray));color=vec4(vec3(x),1);}
  `;

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
      ["resolution", "pan", "jitter", "camera"].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );

    const defaults = { yaw: 0, pitch: 0.2, distance: 7.2, panX: 0, panY: 0 };
    const view = { ...defaults },
      pointers = new Map();
    const jitters = [
      [-0.375, -0.375],
      [0.125, -0.375],
      [-0.125, -0.125],
      [0.375, -0.125],
      [-0.375, 0.125],
      [0.125, 0.125],
      [-0.125, 0.375],
      [0.375, 0.375],
    ];
    const accTexture = gl.createTexture(),
      accBuffer = gl.createFramebuffer();
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let gesture,
      frame,
      timer,
      done = 0,
      samples = 8,
      scale;
    const finalScale = () =>
      Math.max(
        0.5,
        Math.min(
          Math.max(devicePixelRatio || 1, 2),
          3,
          maxSize / innerWidth,
          maxSize / innerHeight,
          Math.sqrt(12000000 / (innerWidth * innerHeight)),
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
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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
      done = 0;
    };
    const draw = () => {
      frame = 0;
      resize();
      gl.bindFramebuffer(gl.FRAMEBUFFER, accBuffer);
      if (!done) {
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const j = samples === 1 ? [0, 0] : jitters[done];
      gl.uniform2f(u.resolution, canvas.width, canvas.height);
      gl.uniform2f(u.pan, view.panX, view.panY);
      gl.uniform2f(u.jitter, ...j);
      gl.uniform3f(u.camera, view.yaw, view.pitch, view.distance);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendColor(0, 0, 0, 1 / (done + 1));
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
      done++;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, accBuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(
        0,
        0,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (done < samples) frame = requestAnimationFrame(draw);
    };
    const quality = (high) => {
      scale = high ? finalScale() : Math.min(devicePixelRatio || 1, 1);
      samples = high ? 8 : 1;
      done = 0;
      frame ||= requestAnimationFrame(draw);
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
