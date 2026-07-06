(() => {
  "use strict";

  const canvas = document.querySelector("#space");
  const reset = document.querySelector("#reset");
  const sound = document.querySelector("#sound");
  const fall = document.querySelector("#fall");
  const infoToggle = document.querySelector("#info-toggle");
  const info = document.querySelector("#info");
  const infoClose = document.querySelector("#info-close");
  const help = document.querySelector(".help");
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
    R = [256, 128],
    EVENT_HORIZON = 0.5,
    DISK_INNER_EDGE = 1.5,
    MIN_DISTANCE = EVENT_HORIZON * 1.0015,
    FALL_PROPER_TIME_RATE = 1,
    HORIZON_TO_SINGULARITY = (2 * EVENT_HORIZON) / 3,
    INTERIOR_TIME_STRETCH = 24,
    SINGULARITY_VISUAL_DEPTH = 4.5,
    AUDIO_FAR_DISTANCE = 12,
    MAX_DISTANCE = 48;
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
    uniform vec2 resolution,pan,jitter,look;
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
      float cy=cos(look.x),sy=sin(look.x),cp=cos(look.y),sp=sin(look.y);
      vec3 turned=cy*f+sy*r;
      r=cy*r-sy*f;
      f=cp*turned+sp*u;
      u=cp*u-sp*turned;
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
    uniform float time,falling,interior;
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
    float rimMask(float u,float orbitalPhase){
      float r=EH/max(u,1e-5);
      float q=clamp((r-RI)/(RO-RI),0.,1.);
      vec2 stir=vec2(cos(time*.41),sin(time*.37));
      float drift=orbitalPhase-time*(.42+.28/pow(r,.65));
      vec2 orbit=vec2(cos(drift),sin(drift));
      float edge=smoothstep(.70,1.,q);
      float broad=fbm(orbit*2.6+stir*.32+vec2(0.,r*.85));
      float fine=fbm(orbit*10.5-stir.yx*.42+vec2(0.,r*3.9+broad*2.4));
      float scallop=.5+.5*sin(drift*12.+broad*7.+r*2.2);
      float ragged=smoothstep(.30,.76,.50*broad+.32*fine+.18*scallop);
      float reach=mix(.72,.985,ragged);
      float feather=mix(.18,.055,ragged);
      float taper=1.-smoothstep(reach,min(1.,reach+feather),q);
      return mix(1.,mix(.08,1.,ragged)*taper,edge);
    }
    float hash31(vec3 p){
      p=fract(p*vec3(443.897,441.423,437.195));
      p+=dot(p,p.yzx+19.19);
      return fract((p.x+p.y)*p.z);
    }
    float noise3(vec3 p){
      vec3 i=floor(p),f=fract(p);
      f=f*f*(3.-2.*f);
      return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),
                     mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
                 mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),
                     mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
    }
    vec3 shiftedSpectrum(vec3 color,float shift);
    vec3 plasma(float u,float opacity,float height,float orbitalPhase,float shift){
      float r=EH/max(u,1e-5);
      float q=clamp((r-RI)/(RO-RI),0.,1.);
      vec2 stir=vec2(cos(time*.43),sin(time*.31));
      vec2 stirFine=vec2(cos(time*.79+1.7),sin(time*.53+2.3));
      // The plasma orbits forward, but the visible turbulence uses limited
      // differential shear so eddies are replenished instead of winding into
      // uniform circular bands.
      float spin=time*(.62+.42/pow(r,.65));
      // Screen-space phase avoids the parity reversal of secondary lens images.
      // Subtracting spin makes every visible feature advance counterclockwise.
      float angle=orbitalPhase-spin;
      vec2 orbit=vec2(cos(angle),sin(angle));
      vec2 flow=orbit*5.2+
                vec2(r*7.5+height*9.,r*20.)+stir*.62;
      float coarse=fbm(flow);
      float fine=fbm(orbit*18.+stirFine*.72+
                     vec2(-r*9.+height*21.,
                          r*72.+coarse*4.));
      float filaments=smoothstep(.28,.92,.52*coarse+.72*fine);
      float knots=fbm(orbit*2.1-stir*.30+vec2(0.,r*5.7));
      float rim=rimMask(u,orbitalPhase);
      float outerGas=smoothstep(.36,.96,q);
      float outerFade=smoothstep(.18,.86,q);
      float outerTint=smoothstep(.54,1.0,q);
      float rimGas=smoothstep(.78,.97,q);
      float gapField=.52*fbm(orbit*3.4+stir*.38+vec2(0.,r*2.3))+
                     .48*fbm(orbit*13.5-stirFine*.46+vec2(0.,r*6.8));
      float intermittent=mix(1.,smoothstep(.38,.78,gapField),rimGas);
      float wispiness=mix(1.,mix(.36,1.08,smoothstep(.18,.88,fine)),outerFade);
      float eddyA=fbm(orbit*8.4+stirFine*1.18+
                      vec2(r*3.2,height*4.5));
      float eddyB=fbm(orbit*23.0-stir.yx*1.55+
                      vec2(-r*8.5,height*15.0));
      float churn=smoothstep(.26,.80,.54*eddyA+.46*eddyB);
      float density=mix(.42,1.10,filaments);
      density*=mix(.72,1.32,smoothstep(.22,.86,knots));
      density*=mix(.62,1.42,churn);
      density*=exp(-height*height*2.2);
      density*=mix(1.,.28,outerFade)*intermittent*wispiness*rim;
      float diskProfile=max(0.,pow(RI/max(r,RI),3.)*(1.-sqrt(RI/max(r,RI))));
      float heat=mix(pow(1.-q,.42),pow(clamp(diskProfile*55.,0.,1.),.25),.65);
      float hot=pow(heat,2.2)*mix(.52,1.48,fine)*mix(.8,1.25,knots);
      vec3 copper=vec3(1.0,.16,.025);
      vec3 amber=vec3(1.0,.48,.13);
      vec3 white=vec3(1.0,.88,.62);
      vec3 tint=mix(copper,amber,smoothstep(0.,.78,heat));
      tint=mix(tint,white,smoothstep(.48,1.08,hot));
      tint=mix(tint,vec3(.78,.36,.13),outerTint*.62);
      float gasGlow=mix(1.15+5.8*hot,.26+1.36*hot,outerFade);
      return shiftedSpectrum(tint,shift)*opacity*density*gasGlow;
    }
    vec3 fallRay(vec3 local,out float frequencyShift){
      // Exact local aberration for a radial geodesic dropped from rest at
      // infinity: its speed relative to a stationary Schwarzschild observer is
      // beta=sqrt(r_s/r). "local" points toward the observed source.
      vec3 observed=normalize(local);
      float beta=sqrt(clamp(observerU,0.,.999999));
      float mu=dot(observed,radial);
      float denominator=max(1.+beta*mu,1e-6);
      float staticMu=(mu+beta)/denominator;
      vec3 transverse=observed-mu*radial;
      vec3 stationary=normalize(
        staticMu*radial+transverse*lapse/denominator
      );

      // Conserved photon energy gives nu_observer/nu_infinity. Directly behind
      // the infaller this approaches 1/2 at the event horizon, not zero.
      frequencyShift=(1.-beta*staticMu)/max(lapse*lapse,1e-6);

      // Convert the stationary observer's orthonormal radial component to the
      // Schwarzschild spatial coordinate used by the geodesic integrator.
      float radialPart=dot(stationary,radial);
      return normalize(
        stationary+radialPart*(lapse-1.)*radial
      );
    }
    vec3 shiftedSpectrum(vec3 color,float shift){
      float g=clamp(shift,.12,3.);
      if(g<1.){
        vec3 red=vec3(color.r+.5*color.g+.12*color.b,
                      .55*color.g+.1*color.b,
                      .18*color.b);
        color=mix(red,color,g);
      }else{
        float blue=1.-1./g;
        vec3 hot=vec3(.62*color.r,
                      color.g+.18*color.r,
                      color.b+.42*color.g);
        color=mix(color,hot,blue);
      }
      // I_nu/nu^3 is invariant along a vacuum null geodesic.
      return color*clamp(g*g*g,.015,12.);
    }
    float diskShift(){
      float observerLapse=max(lapse,.18);
      // A screen-continuous approximation to Schwarzschild circular-orbit
      // Doppler beaming. Keeping it independent of the lensed branch removes
      // nonphysical brightness seams between primary and secondary images.
      float beta=.44;
      float gamma=1./sqrt(max(1.-beta*beta,1e-4));
      float inclination=sqrt(max(1.-radial.y*radial.y,0.));
      vec2 center=resolution*.5+pan*resolution.y*.5;
      float screenX=clamp((gl_FragCoord.x-center.x)/(resolution.y*.48),-1.,1.);
      float approach=-screenX*inclination;
      float gravitational=.82/observerLapse;
      float doppler=1./(gamma*max(1.-beta*approach,.35));
      return clamp(gravitational*doppler,.68,1.42);
    }
    vec3 higherOrderRing(vec3 local,float orbitalPhase){
      float infallShift=1.;
      vec3 d;
      if(falling>.5)d=fallRay(local,infallShift);
      else d=local+dot(local,radial)*(lapse-1.)*radial;

      float delta=acos(clamp(dot(radial,normalize(d)),-1.,1.));
      float ud=-observerU/tan(delta);
      float e=ud*ud+observerU*observerU*(1.-observerU);
      float critical=abs(e/MU-1.);
      float aa=max(fwidth(e/MU),1e-5);

      // Near e = MU, rays skim the photon sphere. This adds a faint unresolved
      // higher-order disk image rather than another broad decorative halo.
      float hairline=1.-smoothstep(aa*.55,aa*2.2+.0028,critical);
      float shoulder=1.-smoothstep(aa*1.2+.003,aa*5.5+.018,critical);
      float ring=max(hairline*.82,shoulder*.22);

      float az=orbitalPhase-time*.34;
      float sourceArc=.50+.50*smoothstep(.05,.82,abs(sin(az)));
      float fine=.86+.14*sin(az*18.+time*.7);
      vec3 tint=shiftedSpectrum(vec3(1.,.46,.14),diskShift());
      if(falling>.5)tint=shiftedSpectrum(tint,clamp(infallShift,.35,1.8));
      return tint*ring*sourceArc*fine*.045;
    }
    vec3 trace(vec3 local,float height,float orbitalPhase){
      float lr=dot(local,radial);
      float shift=1.;
      vec3 d;
      if(falling>.5)d=fallRay(local,shift);
      else d=local+lr*(lapse-1.)*radial;
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
      float diskColorShift=diskShift();
      float shift0=diskColorShift;
      float shift1=diskColorShift;
      if(o0>0.)light+=plasma(u0,o0,height,orbitalPhase,shift0);
      if(o1>0.)light+=plasma(u1,o1,height,orbitalPhase,shift1);

      // A low-energy sheath gives the optically thick surface a soft edge
      // without changing the solved geodesic silhouette.
      float halo0=v0?pulse(UO*.965,(EH/RI)*1.015,u0,max(w0,.006)):0.;
      float halo1=v1?pulse(UO*.965,(EH/RI)*1.015,u1,max(w1,.006)):0.;
      float rim0=v0?rimMask(u0,orbitalPhase):0.;
      float rim1=v1?rimMask(u1,orbitalPhase):0.;
      light+=vec3(1.,.25,.045)*.11*(halo0*rim0+halo1*rim1);
      if(falling>.5)
        light=shiftedSpectrum(light,clamp(shift,.35,1.8));
      return light;
    }
    vec3 spaceColor(vec3 d,float starVisibility){
      d=normalize(d);
      vec3 grid=d*620.;
      vec3 cell=floor(grid);
      vec3 local=fract(grid)-.5;
      float h=hash31(cell);
      vec3 starOffset=vec3(hash31(cell+11.),
                           hash31(cell+29.),
                           hash31(cell+47.))-.5;
      vec3 starPoint=local-starOffset*.30;
      float starDistance=length(starPoint);
      float starSize=mix(.045,.095,pow(hash31(cell+83.),2.));
      float starEdge=max(fwidth(starDistance),.006);
      float starCore=1.-smoothstep(starSize,starSize+starEdge,starDistance);
      float haloRadius=starSize*2.75;
      float starGlow=exp(-starDistance*starDistance/
                         max(starSize*starSize*4.4,1e-4))*
                     (1.-smoothstep(haloRadius*.72,haloRadius,starDistance))*
                     .24;
      float star=smoothstep(.9958,1.,h)*(starCore+starGlow)*starVisibility;
      float twinkle=.97+.03*sin(time*(.45+h)+h*53.);
      vec3 tint=mix(vec3(.48,.62,1.),vec3(1.,.74,.46),hash31(cell+7.));
      float milky=pow(max(0.,1.-abs(d.y*.72+d.x*.18)),8.);
      float dust=noise3(d*7.)*noise3(d*19.+3.);
      vec3 sky=vec3(.0015,.002,.004);
      sky+=tint*star*(1.7+4.*pow(h,16.))*twinkle;
      sky+=vec3(.018,.022,.032)*milky*dust;
      return sky;
    }
    vec3 spaceColor(vec3 d){
      return spaceColor(d,1.);
    }
    vec3 raytracedSpace(vec3 local){
      // This is the numerical light-path integration from the reference
      // renderer, expressed in the same Schwarzschild units as the lookup
      // geometry. There is no screen-space lens mask or circular blend.
      const float HORIZON=EH;
      vec3 pos=radial*(EH/max(observerU,1e-6));
      float frequencyShift=1.;
      float centerPointStarFade=falling>.5?
        smoothstep(.04,.18,length(normalize(local)+radial)):1.;
      vec3 dir;
      if(falling>.5)dir=fallRay(local,frequencyShift);
      else dir=normalize(local);
      for(int i=0;i<176;i++){
        float r=length(pos);
        if(r<HORIZON*1.001)return vec3(0);
        if(r>46.&&dot(pos,dir)>0.){
          vec3 sky=spaceColor(dir,centerPointStarFade);
          return falling>.5?shiftedSpectrum(sky,frequencyShift):sky;
        }

        float radialSpeed=dot(pos,dir);
        float h2=max(dot(pos,pos)-radialSpeed*radialSpeed,0.);
        float ds=clamp((r-HORIZON)*.1,.035,.68);
        if(r>15.)ds=min(ds,1.);

        float invR=1./max(r,HORIZON*1.01);
        float invR2=invR*invR;
        vec3 accel=-1.5*HORIZON*h2*pos*(invR2*invR2*invR);
        dir=normalize(dir+accel*ds);
        pos+=dir*ds;
      }
      // Rays still orbiting after the full budget belong to the shadow.
      return vec3(0);
    }
    vec3 interiorOutsideRay(vec3 observed){
      float closure=1.-exp(-interior*.22);
      float cone=mix(PI,.34,closure);
      float mu=clamp(dot(observed,radial),-1.,1.);
      float angle=acos(mu);
      vec3 tangent=observed-mu*radial;
      float tl=length(tangent);
      if(tl<1e-5){
        vec3 helper=abs(radial.y)<.95?vec3(0,1,0):vec3(1,0,0);
        tangent=normalize(cross(cross(radial,helper),radial));
      }else tangent/=tl;

      // After the horizon handoff, outside light is still sampled from the
      // exterior Schwarzschild solution, but the visible sky is angularly
      // squeezed toward the outward light cone instead of simply fading out.
      float folded=angle*cone/PI;
      vec3 foldedRay=normalize(cos(folded)*radial+sin(folded)*tangent);
      vec3 axisRay=mu>=0.?radial:-radial;
      return normalize(mix(axisRay,foldedRay,smoothstep(.0,.035,tl)));
    }
    void main(){
      vec3 observed=normalize(ray);
      vec2 center=resolution*.5+pan*resolution.y*.5;
      float orbitalPhase=atan(gl_FragCoord.y-center.y,
                              gl_FragCoord.x-center.x);
      // A smooth Gaussian density profile sampled through the disk atmosphere.
      // Every layer uses the original geodesic solver; only optical depth varies.
      vec3 exteriorRay=observed;
      float interiorClosure=0.;
      float exteriorAttenuation=1.;
      float terminalFade=1.;
      float interiorCaustic=0.;
      if(interior>0.){
        interiorClosure=1.-exp(-interior*.22);
        exteriorRay=interiorOutsideRay(observed);
        float angle=acos(clamp(dot(observed,radial),-1.,1.));
        float rim=abs(angle/PI-.72);
        terminalFade=1.-smoothstep(4.2,8.4,interior);
        interiorCaustic=interiorClosure*exp(-rim*rim*170.)*terminalFade;
        exteriorAttenuation=exp(-interior*.035)*terminalFade;
      }
      vec3 sky=raytracedSpace(exteriorRay);
      if(interior>0.){
        // Once inside, a shrinking outside light cone should dim continuously.
        // Blend away from the exterior escape/capture test so rays do not
        // all snap black when the compressed cone crosses the photon shadow.
        float centerPointStarFade=smoothstep(.04,.18,
                                             length(observed+radial));
        vec3 coneSky=shiftedSpectrum(spaceColor(exteriorRay,
                                                centerPointStarFade),
                                     mix(.96,.72,interiorClosure));
        sky=mix(sky,coneSky,smoothstep(.06,.75,interior));
      }
      sky*=exteriorAttenuation;
      // Keep the accretion disk on its solved geodesics. A single luminous
      // stream avoids the stacked line artifacts that appear when lensed height
      // slices separate near the photon ring.
      vec3 disk=(trace(exteriorRay,0.,orbitalPhase)
                +higherOrderRing(exteriorRay,orbitalPhase))*1.05;
      // The disk stays outside and behind the infaller. Its geodesic images
      // leave view only when their shared outward causal window closes.
      disk*=exteriorAttenuation;
      vec3 hdr=sky+disk;
      hdr+=vec3(1.,.34,.07)*interiorCaustic*.08*exteriorAttenuation;
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
      vec2 px=1./resolution;
      vec3 c=texture(scene,at).rgb;
      float nearby=max(
        max(max(texture(scene,at+vec2(1,0)*px).r,
                texture(scene,at-vec2(1,0)*px).r),
            texture(scene,at+vec2(0,1)*px).r),
        texture(scene,at-vec2(0,1)*px).r);
      // Extended plasma blooms. Isolated point stars retain compact halos
      // instead of exposing the sparse bloom kernel as a cross.
      float bloomSupport=smoothstep(.018,.11,nearby);
      return max(c-vec3(.055),0.)*bloomSupport;
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
      float luminous=smoothstep(.012,.28,max(meld.r,max(meld.g,meld.b)));
      float localEnergy=(
        max(texture(scene,uv+vec2(1,0)*px).r,
            texture(scene,uv+vec2(1,0)*px).g)
       +max(texture(scene,uv-vec2(1,0)*px).r,
            texture(scene,uv-vec2(1,0)*px).g)
       +max(texture(scene,uv+vec2(0,1)*px).r,
            texture(scene,uv+vec2(0,1)*px).g)
       +max(texture(scene,uv-vec2(0,1)*px).r,
            texture(scene,uv-vec2(0,1)*px).g))*.25;
      float extendedSource=smoothstep(.055,.22,localEnergy);
      base=mix(base,meld,luminous*extendedSource*.74);
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
      float source=max(base.r,max(base.g,base.b));
      float shadowKeep=smoothstep(.012,.075,source);
      glow*=shadowKeep;
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
      [
        "resolution",
        "pan",
        "jitter",
        "camera",
        "look",
        "time",
        "falling",
        "interior",
      ].map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    gl.useProgram(postProgram);
    gl.uniform1i(gl.getUniformLocation(postProgram, "scene"), 2);
    const postResolution = gl.getUniformLocation(postProgram, "resolution");

    const defaults = {
      yaw: 0,
      targetYaw: 0,
      pitch: 0.2,
      targetPitch: 0.2,
      distance: 7.2,
      panX: 0,
      panY: 0,
      lookYaw: 0,
      targetLookYaw: 0,
      lookPitch: 0,
      targetLookPitch: 0,
    };
    const view = { ...defaults },
      pointers = new Map();

    // A procedural, continuously evolving roar avoids the obvious repetition of
    // a short audio loop. It begins after the first user gesture, as required by
    // browser autoplay policies.
    let audio,
      fallMode = false,
      fallRadius = defaults.distance,
      insideProperTime = 0,
      interiorDepth = 0,
      lastAudioUpdate = -Infinity,
      soundEnabled = false;
    const makeBlackHoleAudio = () => {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        sound.hidden = true;
        return null;
      }

      const context = new AudioContext();
      const master = context.createGain();
      const drone = context.createGain();
      const droneFilter = context.createBiquadFilter();
      const turbulence = context.createGain();
      const turbulenceFilter = context.createBiquadFilter();
      const shear = context.createGain();
      const shearFilter = context.createBiquadFilter();
      const compressor = context.createDynamicsCompressor();
      const pitch = 0.1;

      master.gain.value = 0;
      drone.gain.value = 0.7;
      droneFilter.type = "lowpass";
      droneFilter.frequency.value = 150 * pitch;
      droneFilter.Q.value = 1.2;
      turbulenceFilter.type = "lowpass";
      turbulenceFilter.frequency.value = 180 * pitch;
      turbulenceFilter.Q.value = 0.65;
      shearFilter.type = "bandpass";
      shearFilter.frequency.value = 420 * pitch;
      shearFilter.Q.value = 0.8;
      compressor.threshold.value = -20;
      compressor.knee.value = 16;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.012;
      compressor.release.value = 0.28;

      drone.connect(droneFilter).connect(master);
      turbulence.connect(turbulenceFilter).connect(master);
      shear.connect(shearFilter).connect(master);
      master.connect(compressor).connect(context.destination);

      [
        ["sine", 29, 0.7],
        ["triangle", 43.5, 0.34],
        ["sawtooth", 58, 0.085],
        ["sine", 87, 0.12],
        ["triangle", 116, 0.075],
        ["sine", 174, 0.045],
      ].forEach(([type, frequency, level]) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = type;
        oscillator.frequency.value = frequency * pitch;
        oscillator.detune.value = (Math.random() - 0.5) * 7;
        gain.gain.value = level;
        oscillator.connect(gain).connect(drone);
        oscillator.start();
      });

      // Integrated random samples create a heavy, non-hissy turbulent bed.
      const noiseBuffer = context.createBuffer(
        1,
        context.sampleRate * 4,
        context.sampleRate,
      );
      const samples = noiseBuffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < samples.length; i++) {
        brown = (brown + Math.random() * 0.16 - 0.08) / 1.015;
        samples[i] = brown * 2.6;
      }
      const noise = context.createBufferSource();
      const noiseSplit = context.createGain();
      noise.buffer = noiseBuffer;
      noise.loop = true;
      noise.connect(noiseSplit);
      noiseSplit.connect(turbulence);
      noiseSplit.connect(shear);
      noise.start();

      // Slow irregular "pressure" oscillation keeps the roar alive.
      const pressure = context.createOscillator();
      const pressureDepth = context.createGain();
      pressure.type = "sine";
      pressure.frequency.value = 0.115;
      pressureDepth.gain.value = 0.08;
      pressure.connect(pressureDepth).connect(drone.gain);
      pressure.start();

      return {
        context,
        master,
        droneFilter,
        turbulence,
        turbulenceFilter,
        shear,
        shearFilter,
        pitch,
      };
    };
    const updateAudio = (immediate = false) => {
      if (!audio) return;
      const now = audio.context.currentTime;
      if (!immediate && fallMode && now - lastAudioUpdate < 0.06) return;
      lastAudioUpdate = now;
      const diskApproach = Math.max(
        0,
        Math.min(
          1,
          (AUDIO_FAR_DISTANCE - view.distance) /
            (AUDIO_FAR_DISTANCE - DISK_INNER_EDGE),
        ),
      );
      const smoothApproach =
        diskApproach * diskApproach * (3 - 2 * diskApproach);
      const rise = (Math.exp(smoothApproach * 4.6) - 1) / (Math.exp(4.6) - 1);
      const horizonDistance = Math.max(
        0,
        Math.min(
          1,
          (view.distance - MIN_DISTANCE) / (DISK_INNER_EDGE - MIN_DISTANCE),
        ),
      );
      // The inner disk is the acoustic peak. Inside it, a smooth turning point
      // rolls the roar down to a muffled residual hum at the horizon.
      const horizonFade =
        horizonDistance * horizonDistance * (3 - 2 * horizonDistance);
      const intensity = rise * horizonFade;
      const ambientFloor = 0.007 + 0.021 * horizonFade;
      const ramp = immediate ? 0.01 : 0.12;
      const target = (parameter, value) =>
        parameter.setTargetAtTime(value, now, ramp);
      const interiorSilence = Math.exp(-interiorDepth * 1.15);

      target(
        audio.master.gain,
        soundEnabled ? (ambientFloor + intensity * 0.54) * interiorSilence : 0,
      );
      target(
        audio.droneFilter.frequency,
        (145 + intensity * 1050) * audio.pitch,
      );
      target(audio.turbulence.gain, 0.13 + intensity * 0.62);
      target(
        audio.turbulenceFilter.frequency,
        (170 + intensity * 1350) * audio.pitch,
      );
      target(audio.shear.gain, 0.015 + intensity * 0.7);
      target(
        audio.shearFilter.frequency,
        (380 + intensity * 1750) * audio.pitch,
      );
    };
    const awakenAudio = () => {
      if (!soundEnabled) return;
      if (!audio) audio = makeBlackHoleAudio();
      if (!audio) return;
      if (audio.context.state !== "running") {
        audio.context
          .resume()
          .then(() => updateAudio(true))
          .catch(() => {});
      } else {
        updateAudio();
      }
    };

    const accTexture = gl.createTexture(),
      accBuffer = gl.createFramebuffer();
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let gesture, frame, timer, scale;
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
    const startTime = performance.now();
    let previousTime = startTime;
    const draw = (now) => {
      const dt = Math.min((now - previousTime) * 0.001, 0.05);
      previousTime = now;
      const ease = Math.min(1, dt * 5);
      if (fallMode) {
        const properStep = dt * FALL_PROPER_TIME_RATE;
        if (fallRadius > 0) {
          // Radial geodesic for an observer dropped from rest at infinity:
          // dr/dtau = -sqrt(r_s / r). The displayed Schwarzschild coordinate
          // is clamped just outside r_s because the exterior chart is singular
          // at the horizon, but the simulated worldline keeps crossing.
          const safeRadius = Math.max(fallRadius, EVENT_HORIZON);
          fallRadius = Math.max(
            0,
            fallRadius - Math.sqrt(EVENT_HORIZON / safeRadius) * properStep,
          );
          view.distance = Math.max(MIN_DISTANCE, fallRadius);
        }
        if (fallRadius <= EVENT_HORIZON) {
          insideProperTime += properStep;
          // Scale-free black-hole units can make horizon-to-singularity time
          // visually tiny. Stretch only the display clock so crossing the
          // horizon remains locally uneventful.
          interiorDepth =
            (insideProperTime /
              (HORIZON_TO_SINGULARITY * INTERIOR_TIME_STRETCH)) *
            SINGULARITY_VISUAL_DEPTH;
        }
        updateAudio();
        updateChrome();
      }
      view.yaw += (view.targetYaw - view.yaw) * ease;
      view.pitch += (view.targetPitch - view.pitch) * ease;
      view.lookYaw += (view.targetLookYaw - view.lookYaw) * ease;
      view.lookPitch += (view.targetLookPitch - view.lookPitch) * ease;
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
      gl.uniform2f(u.look, view.lookYaw, view.lookPitch);
      gl.uniform1f(u.time, (now - startTime) * 0.001);
      gl.uniform1f(u.falling, fallMode ? 1 : 0);
      gl.uniform1f(u.interior, fallMode ? interiorDepth : 0);
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
      updateAudio();
      updateChrome();
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
    const zoomBy = (factor) => {
      // Scale altitude above the horizon rather than the absolute radius. This
      // gives the final approach enough precision while never crossing r = 0.5.
      const altitude = (view.distance - EVENT_HORIZON) * factor;
      view.distance =
        EVENT_HORIZON +
        Math.max(
          MIN_DISTANCE - EVENT_HORIZON,
          Math.min(MAX_DISTANCE - EVENT_HORIZON, altitude),
        );
    };
    const updateChrome = () => {
      const horizonDistance = Math.max(
        0,
        Math.min(
          1,
          (view.distance - MIN_DISTANCE) / (DISK_INNER_EDGE - MIN_DISTANCE),
        ),
      );
      const opacity =
        horizonDistance * horizonDistance * (3 - 2 * horizonDistance);
      document.body.style.setProperty("--ui-opacity", opacity.toFixed(3));
      document.body.classList.toggle("ui-hidden", opacity < 0.035);
    };
    const setFallMode = (enabled) => {
      fallMode = enabled;
      if (fallMode && view.distance <= MIN_DISTANCE + 0.002)
        view.distance = defaults.distance;
      if (fallMode) {
        fallRadius = view.distance;
        insideProperTime = 0;
        interiorDepth = 0;
        view.panX = 0;
        view.panY = 0;
        awakenAudio();
      } else {
        fallRadius = view.distance;
        insideProperTime = 0;
        interiorDepth = 0;
        view.lookYaw = 0;
        view.targetLookYaw = 0;
        view.lookPitch = 0;
        view.targetLookPitch = 0;
      }
      document.body.classList.toggle("falling", fallMode);
      fall.textContent = fallMode ? "Exit fall" : "Fall mode";
      fall.setAttribute("aria-pressed", String(fallMode));
      help.innerHTML = fallMode
        ? "Drag: look around · Turn fully to look behind<br>F or Esc: exit fall"
        : "Drag: orbit · Shift drag: move<br>Wheel or pinch: zoom";
      updateChrome();
      quality(true);
    };

    canvas.addEventListener("pointerdown", (e) => {
      awakenAudio();
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
      if (fallMode) {
        view.targetLookYaw -= (point.x - old.x) * 0.006;
        view.targetLookPitch = Math.max(
          -1.5,
          Math.min(1.5, view.targetLookPitch + (point.y - old.y) * 0.0045),
        );
        gesture = next;
      } else if (next && gesture) {
        zoomBy(gesture.distance / Math.max(next.distance, 1));
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
          view.targetYaw -= dx * 0.0045;
          view.targetPitch = Math.max(
            -1.42,
            Math.min(1.42, view.targetPitch + dy * 0.0035),
          );
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
        if (fallMode) return;
        awakenAudio();
        zoomBy(Math.exp(e.deltaY * 0.0022));
        moving();
      },
      { passive: false },
    );
    reset.addEventListener("click", () => {
      awakenAudio();
      setFallMode(false);
      Object.assign(view, defaults);
      updateAudio(true);
      updateChrome();
      quality(true);
    });
    infoToggle.addEventListener("click", () => {
      if (info.open) return;
      info.showModal();
      infoToggle.setAttribute("aria-expanded", "true");
    });
    infoClose.addEventListener("click", () => info.close());
    info.addEventListener("click", (e) => {
      if (e.target === info) info.close();
    });
    info.addEventListener("close", () => {
      infoToggle.setAttribute("aria-expanded", "false");
    });
    fall.addEventListener("click", () => setFallMode(!fallMode));
    sound.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      sound.textContent = `Sound: ${soundEnabled ? "on" : "off"}`;
      sound.setAttribute("aria-pressed", String(soundEnabled));
      if (soundEnabled) awakenAudio();
      updateAudio(true);
    });
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (info.open) return;
      if (e.key === "Escape" && fallMode) setFallMode(false);
    });
    addEventListener("resize", () => quality(true), { passive: true });
    updateChrome();
    quality(true);
  })().catch((error) => {
    console.error(error);
    fail("The black hole renderer could not start.");
  });
})();
