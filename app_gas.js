(() => {
  "use strict";

  const [canvas, reset, sound, fall, help] = [
    "#space",
    "#reset",
    "#sound",
    "#fall",
    ".help",
  ].map((selector) => document.querySelector(selector));
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
    MIN_DISTANCE = 0.50075,
    INTERIOR_HANDOFF = 1.25,
    INTERIOR_HANDOFF_END = 1.05,
    AUDIO_FAR_DISTANCE = 12,
    MAX_DISTANCE = 48;
  const DC = D[0] * D[1],
    RC = R[0] * R[1];
  const clamp = (value, min = 0, max = 1) =>
      Math.max(min, Math.min(max, value)),
    smooth = (value) => value * value * (3 - 2 * value);
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
    uniform sampler2D deflectionTable,radiusTable,noiseTexture;
    uniform vec2 resolution,pan;
    uniform float time,falling,interior;
    out vec4 color;
    const float PI=3.141592653589793,MU=4./27.,EH=.5,RI=1.5,RO=7.4;
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
    vec3 plasma(float u,float opacity,float height,float orbitalPhase){
      float r=EH/max(u,1e-5);
      float q=clamp((r-RI)/(RO-RI),0.,1.);
      float spin=time*(1.72/pow(r,1.5));
      vec2 flow=vec2(
        orbitalPhase/(2.*PI)-spin/(2.*PI),
        q
      );

      vec4 broadField=textureLod(
        noiseTexture,
        flow+vec2(height*.009,-height*.018),
        0.
      );
      vec2 warp=broadField.rg-.5;
      vec4 detailField=textureLod(
        noiseTexture,
        flow*vec2(3.,2.35)+warp*vec2(.19,.15)+
          vec2(time*.003+height*.010,height*.021),
        0.
      );
      float broad=broadField.b;
      float rockField=broad*.55+detailField.g*.28+detailField.a*.17;
      float molten=smoothstep(.32,.76,rockField);
      float crust=smoothstep(.55,.84,
        broadField.r*.58+detailField.r*.42);
      float sand=detailField.a*.55+detailField.b*.45;
      float outerMix=smoothstep(.46,.88,q);
      float whiteCore=1.-smoothstep(.08,.25,q);

      float clumps=exp2(clamp(2.65*(rockField-.5),-1.7,1.45));
      float density=clumps*mix(.42,1.34,molten);
      density*=mix(1.,.46,crust*(1.-molten*.58));
      float midplane=exp(-pow(abs(height),3.2));
      float atmosphere=exp(-abs(height)*.66);
      float vertical=.60*midplane+.40*atmosphere;
      float sandyDensity=mix(.30,1.12,sand)*
                         exp2(1.15*(broad-.5));
      density=mix(density,sandyDensity,outerMix);
      density*=vertical;
      density=mix(density,1.42*vertical,whiteCore*.92);
      density*=2.;

      float innerEdge=smoothstep(RI,RI+.10,r);
      float outerEdge=pow(
        max(1.-smoothstep(RO-2.10,RO,r),0.),
        1.85
      );
      float edge=innerEdge*outerEdge;
      float heat=pow(max(1.-q,0.),1.8);
      float hot=heat*heat*mix(.24,1.26,molten)*
                mix(.72,1.12,broad);

      vec3 ember=vec3(.48,.045,.006);
      vec3 copper=vec3(1.0,.24,.035);
      vec3 cream=vec3(1.0,.82,.54);
      vec3 white=vec3(1.0,.985,.91);
      vec3 tint=mix(ember,copper,smoothstep(.02,.46,heat));
      tint=mix(tint,cream,smoothstep(.38,.96,hot));
      tint=mix(tint,white,smoothstep(1.02,1.38,hot));
      vec3 sandDark=vec3(.20,.045,.012);
      vec3 sandLight=vec3(.68,.24,.055);
      vec3 sandTint=mix(sandDark,sandLight,sand);
      tint=mix(tint,sandTint,outerMix);
      tint=mix(tint,vec3(1.,.975,.86),whiteCore*.96);

      float beaming=.83+.23*sin(orbitalPhase+1.1);
      float emission=density*edge*(.045+3.45*hot)*
                     mix(1.,.28,outerMix);
      emission=mix(emission,6.2*edge*vertical,whiteCore*.94);
      return tint*opacity*emission*beaming;
    }
    vec3 fallRay(vec3 local,out float frequencyShift){
      vec3 observed=normalize(local);
      float beta=sqrt(clamp(observerU,0.,.999999));
      float mu=dot(observed,radial);
      float denominator=max(1.+beta*mu,1e-6);
      float staticMu=(mu+beta)/denominator;
      vec3 transverse=observed-mu*radial;
      vec3 stationary=normalize(
        staticMu*radial+transverse*lapse/denominator
      );

      frequencyShift=(1.-beta*staticMu)/max(lapse*lapse,1e-6);

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
      return color*clamp(g*g*g,.015,12.);
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
      float flip0=mod(floor(p/PI),2.);
      vec3 hitAxis0=flip0<1.?axis:-axis;
      float hitPhi0=atan(hitAxis0.z,hitAxis0.x);
      bool v0=p0<pa;
      float rs=side*(c0-observerU);
      v0=v0&&(rs>1e-3||(rs>-1e-3&&alpha<delta));
      float u0=v0?c0:-1.;

      float reflected=2.*pa-p;
      float p1=mod(reflected,PI),c1=radius(e,p1);
      float flip1=mod(floor(reflected/PI),2.);
      vec3 hitAxis1=flip1<1.?axis:-axis;
      float hitPhi1=atan(hitAxis1.z,hitAxis1.x);
      bool v1=e<MU&&side>0.&&p1<pa;
      float u1=v1?c1:-1.;
      float w0=min(fwidth(c0),fwidth(u0<0.?u1:u0));
      float w1=min(fwidth(c1),fwidth(u1<0.?u0:u1));
      float o0=v0?pulse(UO,EH/RI,u0,w0):0.;
      float o1=v1?pulse(UO,EH/RI,u1,w1):0.;
      if(observerU<UO&&e<GUARD)return vec3(0);

      vec3 light=vec3(0);
      if(o0>0.)light+=plasma(u0,o0,height,hitPhi0);
      if(o1>0.)light+=plasma(u1,o1,height,hitPhi1);

      float halo0=v0?pulse(UO*.965,(EH/RI)*1.015,u0,max(w0,.006)):0.;
      float halo1=v1?pulse(UO*.965,(EH/RI)*1.015,u1,max(w1,.006)):0.;
      light+=vec3(1.,.25,.045)*.11*(halo0+halo1);
      if(falling>.5)
        light=shiftedSpectrum(light,clamp(shift,.35,1.8));
      return light;
    }
    vec3 spaceColor(vec3 d){
      d=normalize(d);
      vec3 cell=floor(d*620.);
      float h=hash31(cell);
      float star=smoothstep(.9965,1.,h);
      float twinkle=.97+.03*sin(time*(.45+h)+h*53.);
      vec3 tint=mix(vec3(.48,.62,1.),vec3(1.,.74,.46),hash31(cell+7.));
      float milky=pow(max(0.,1.-abs(d.y*.72+d.x*.18)),8.);
      float dust=noise3(d*7.)*noise3(d*19.+3.);
      vec3 sky=vec3(.0015,.002,.004);
      sky+=tint*star*(1.7+4.*pow(h,16.))*twinkle;
      sky+=vec3(.018,.022,.032)*milky*dust;
      return sky;
    }
    vec3 raytracedSpace(vec3 local,out vec3 diskLight){
      const float HORIZON=EH;
      diskLight=vec3(0);
      float transmission=1.;
      vec3 pos=radial*(EH/max(observerU,1e-6));
      float frequencyShift=1.;
      vec3 dir;
      if(falling>.5)dir=fallRay(local,frequencyShift);
      else dir=normalize(local);
      float marchSeed=hash21(gl_FragCoord.xy*.75487766);
      for(int i=0;i<176;i++){
        float r=length(pos);
        if(r<HORIZON*1.001)return vec3(0);
        if(r>46.&&dot(pos,dir)>0.){
          vec3 sky=spaceColor(dir)*transmission;
          return falling>.5?shiftedSpectrum(sky,frequencyShift):sky;
        }

        float radialSpeed=dot(pos,dir);
        float h2=max(dot(pos,pos)-radialSpeed*radialSpeed,0.);
        float ds=clamp((r-HORIZON)*.1,.035,.68);
        if(r>15.)ds=min(ds,1.);
        float sampleOffset=fract(
          marchSeed+float(i)*.61803398875
        )-.5;
        vec3 materialPos=pos+dir*ds*sampleOffset;
        float cylindricalR=length(materialPos.xz);

        if(cylindricalR>=RI&&cylindricalR<=RO){
          float diskQ=clamp((cylindricalR-RI)/(RO-RI),0.,1.);
          float scaleHeight=mix(.100,.380,pow(diskQ,.78));
          float normalizedHeight=materialPos.y/scaleHeight;
          if(abs(normalizedHeight)<3.40&&transmission>.008){
            if(abs(normalizedHeight)<.90)ds=min(ds,.050);
            vec3 sampleColor=plasma(
              EH/cylindricalR,
              1.,
              normalizedHeight,
              atan(materialPos.z,materialPos.x)
            );
            if(falling>.5)
              sampleColor=shiftedSpectrum(
                sampleColor,
                clamp(frequencyShift,.35,1.8)
              );
            float verticalDensity=exp(
              -normalizedHeight*normalizedHeight*.82
            );
            float stepDepth=ds/max(scaleHeight,.025);
            float materialDensity=clamp(
              .018+dot(sampleColor,vec3(.055,.085,.025)),
              .012,
              1.15
            );
            float alpha=1.-exp(
              -stepDepth*verticalDensity*materialDensity*.34
            );
            diskLight+=transmission*sampleColor*alpha;
            transmission*=1.-alpha*.28;
          }
        }

        float invR=1./max(r,HORIZON*1.01);
        float invR2=invR*invR;
        vec3 accel=-1.5*HORIZON*h2*pos*(invR2*invR2*invR);
        dir=normalize(dir+accel*ds);
        pos+=dir*ds;
      }
      return vec3(0);
    }
    const float KERR_MASS=.3728075814;
    const float KERR_A=.3504391265;
    const float KERR_HORIZON=.5;
    float kerrRadialPotential(float r,float xi,float eta){
      float delta=r*r-2.*KERR_MASS*r+KERR_A*KERR_A;
      float p=r*r+KERR_A*KERR_A-KERR_A*xi;
      return p*p-delta*(eta+(xi-KERR_A)*(xi-KERR_A));
    }
    float kerrPolarPotential(float theta,float xi,float eta){
      float s=max(abs(sin(theta)),1e-4),c=cos(theta);
      return eta+c*c*(KERR_A*KERR_A-xi*xi/(s*s));
    }
    vec3 boyerLindquistDirection(float theta,float phi){
      float s=sin(theta);
      return vec3(s*cos(phi),cos(theta),s*sin(phi));
    }
    vec3 kerrScene(vec3 local){
      float frequencyShift=1.;
      vec3 launch=local;
      if(falling>.5)launch=fallRay(local,frequencyShift);
      launch=normalize(launch);

      float r=EH/max(observerU,1e-6);
      float theta=acos(clamp(radial.y,-1.,1.));
      float phi=atan(radial.z,radial.x);
      float st=sin(theta),ct=cos(theta),sp=sin(phi),cp=cos(phi);
      vec3 er=vec3(st*cp,ct,st*sp);
      vec3 et=vec3(ct*cp,-st,ct*sp);
      vec3 ep=vec3(-sp,0.,cp);
      float nr=dot(launch,er);
      float nt=dot(launch,et);
      float np=dot(launch,ep);

      float sigma=r*r+KERR_A*KERR_A*ct*ct;
      float delta=r*r-2.*KERR_MASS*r+KERR_A*KERR_A;
      float bigA=(r*r+KERR_A*KERR_A)*(r*r+KERR_A*KERR_A)
                -KERR_A*KERR_A*delta*st*st;
      float alpha=sqrt(max(sigma*delta/bigA,1e-8));
      float omega=2.*KERR_MASS*KERR_A*r/bigA;
      float gpp=bigA*st*st/sigma;
      float angularMomentum=sqrt(max(gpp,1e-8))*np;
      float energy=max(alpha+omega*angularMomentum,1e-5);
      float xi=angularMomentum/energy;
      float pTheta=sqrt(sigma)*nt;
      float eta=(pTheta*pTheta)/(energy*energy)+
                ct*ct*(xi*xi/max(st*st,1e-8)-KERR_A*KERR_A);
      float radialSign=nr>=0.?1.:-1.;
      float polarSign=nt>=0.?1.:-1.;
      float escapeRadius=max(52.,r+4.);

      for(int i=0;i<224;i++){
        if(r<=KERR_HORIZON*1.001)return vec3(0);
        if(r>=escapeRadius&&radialSign>0.){
          vec3 sky=spaceColor(boyerLindquistDirection(theta,phi));
          return falling>.5
            ?shiftedSpectrum(sky,frequencyShift):sky;
        }

        float radialPotential=max(kerrRadialPotential(r,xi,eta),0.);
        float polarPotential=max(kerrPolarPotential(theta,xi,eta),0.);
        float ds=clamp((r-KERR_HORIZON)*.11,.008,.75);
        float dMino=ds/max(r*r+KERR_A*KERR_A,.2);
        float oldR=r,oldTheta=theta,oldPhi=phi;

        float dr=radialSign*sqrt(radialPotential)*dMino;
        float nextR=r+dr;
        if(kerrRadialPotential(nextR,xi,eta)<0.){
          radialSign=-radialSign;
          nextR=r-dr*.35;
        }
        r=max(nextR,KERR_HORIZON*.999);

        float dTheta=polarSign*sqrt(polarPotential)*dMino;
        float nextTheta=theta+dTheta;
        if(nextTheta<=1e-4||nextTheta>=PI-1e-4||
           kerrPolarPotential(nextTheta,xi,eta)<0.){
          polarSign=-polarSign;
          nextTheta=theta-dTheta*.35;
        }
        theta=clamp(nextTheta,1e-4,PI-1e-4);

        float p=oldR*oldR+KERR_A*KERR_A-KERR_A*xi;
        float oldDelta=max(
          oldR*oldR-2.*KERR_MASS*oldR+KERR_A*KERR_A,1e-6
        );
        float sinTheta=max(abs(sin(oldTheta)),1e-4);
        float dPhi=xi/(sinTheta*sinTheta)-KERR_A+
                   KERR_A*p/oldDelta;
        phi+=dPhi*dMino;

        float oldSide=oldTheta-PI*.5,newSide=theta-PI*.5;
        if(oldSide*newSide<=0.&&abs(theta-oldTheta)>1e-7){
          float crossing=abs(oldSide)/
            max(abs(oldSide)+abs(newSide),1e-7);
          float hitR=mix(oldR,r,crossing);
          if(hitR>=RI&&hitR<=RO){
            float hitPhi=mix(oldPhi,phi,crossing);
            vec3 disk=plasma(EH/hitR,.92,0.,hitPhi);
            return falling>.5
              ?shiftedSpectrum(disk,frequencyShift):disk;
          }
        }
      }
      return vec3(0);
    }
    vec3 kerrSceneBundle(vec3 local,vec3 beamX,vec3 beamY){
      vec3 center=kerrScene(local);

      float angle=acos(clamp(dot(normalize(local),-radial),-1.,1.));
      float bundleRadius=clamp(observerU*4.,.035,1.3);
      float bundleStrength=
        1.-smoothstep(bundleRadius*.72,bundleRadius,angle);
      if(bundleStrength<=0.)return center;

      vec3 x=beamX*.5,y=beamY*.5;
      vec3 filtered=center*.28;
      filtered+=kerrScene(normalize(local+x+y))*.18;
      filtered+=kerrScene(normalize(local+x-y))*.18;
      filtered+=kerrScene(normalize(local-x+y))*.18;
      filtered+=kerrScene(normalize(local-x-y))*.18;
      return mix(center,filtered,bundleStrength);
    }
    void main(){
      vec3 observed=normalize(ray);
      vec3 v=observed;
      if(interior>0.){
        float mu=clamp(dot(observed,radial),-1.,1.);
        float observedAngle=acos(mu);
        vec3 transverse=observed-mu*radial;
        float transverseLength=length(transverse);
        if(transverseLength>1e-6){
          float angularScale=max(exp(-interior*.22),.025);
          float sourceAngle=min(observedAngle/angularScale,PI);
          v=cos(sourceAngle)*radial+
            sin(sourceAngle)*(transverse/transverseLength);
        }
      }
      vec2 center=resolution*.5+pan*resolution.y*.5;
      float orbitalPhase=atan(gl_FragCoord.y-center.y,
                              gl_FragCoord.x-center.x);
      vec3 disk;
      vec3 sky=raytracedSpace(v,disk);
      float exteriorWindow=1.,exteriorAttenuation=1.;
      if(interior>0.){
        float closure=1.-exp(-interior*.32);
        float cone=mix(PI,.012,closure);
        float angle=acos(clamp(dot(observed,radial),-1.,1.));
        exteriorWindow=1.-smoothstep(cone*.78,cone,angle);
        exteriorAttenuation=exp(-interior*.1);
        sky*=exteriorWindow*exteriorAttenuation;
      }
      disk*=exteriorWindow*exteriorAttenuation;
      vec3 hdr=sky+disk;
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
      float bloomSupport=smoothstep(.018,.11,nearby);
      return max(c-vec3(.055),0.)*bloomSupport;
    }
    void main(){
      vec2 px=1./resolution;
      vec3 base=texture(scene,uv).rgb;
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
      float localEnergy=(
        max(texture(scene,uv+vec2(1,0)*px).r,
            texture(scene,uv+vec2(1,0)*px).g)
       +max(texture(scene,uv-vec2(1,0)*px).r,
            texture(scene,uv-vec2(1,0)*px).g)
       +max(texture(scene,uv+vec2(0,1)*px).r,
            texture(scene,uv+vec2(0,1)*px).g)
       +max(texture(scene,uv-vec2(0,1)*px).r,
            texture(scene,uv-vec2(0,1)*px).g))*.25;
      float extendedSource=smoothstep(.10,.30,localEnergy);
      base=mix(base,meld,luminous*extendedSource*.68);
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
  const makeProgram = (vertexSource, fragmentSource) => {
    const result = gl.createProgram();
    gl.attachShader(result, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(result, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS))
      return fail(gl.getProgramInfoLog(result));
    return result;
  };
  const program = makeProgram(vertex, fragment);
  if (!program) return;
  const postProgram = makeProgram(postVertex, postFragment);
  if (!postProgram) return;

  const setTextureParameters = (min, mag, wrap) => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  };
  const texture = (data, [w, h], unit) => {
    const result = gl.createTexture(),
      filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, result);
    setTextureParameters(filter, filter, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
    return result;
  };

  const makeNoiseTexture = (size = 256) => {
    const data = new Uint8Array(size * size * 4);
    const frequencies = [7, 11, 19, 47];
    let state = 0x7f4a7c15;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967295;
    };
    frequencies.forEach((frequency, channel) => {
      const lattice = new Float32Array(frequency * frequency);
      for (let i = 0; i < lattice.length; i++) lattice[i] = random();
      for (let y = 0; y < size; y++) {
        const gy = (y / size) * frequency;
        const iy = Math.floor(gy);
        const fy = smooth(gy - iy);
        const iy1 = (iy + 1) % frequency;
        for (let x = 0; x < size; x++) {
          const gx = (x / size) * frequency;
          const ix = Math.floor(gx);
          const fx = smooth(gx - ix);
          const ix1 = (ix + 1) % frequency;
          const a = lattice[iy * frequency + ix];
          const b = lattice[iy * frequency + ix1];
          const c = lattice[iy1 * frequency + ix];
          const d = lattice[iy1 * frequency + ix1];
          const top = a + (b - a) * fx;
          const bottom = c + (d - c) * fx;
          data[(y * size + x) * 4 + channel] = Math.round(
            (top + (bottom - top) * fy) * 255,
          );
        }
      }
    });

    const result = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, result);
    setTextureParameters(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR, gl.REPEAT);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      size,
      size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    return result;
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
    makeNoiseTexture();
    gl.uniform1i(gl.getUniformLocation(program, "deflectionTable"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "radiusTable"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "noiseTexture"), 3);
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
      distance: 9,
      panX: 0,
      panY: 0,
      lookYaw: 0,
      targetLookYaw: 0,
      lookPitch: 0,
      targetLookPitch: 0,
    };
    const view = { ...defaults },
      pointers = new Map();

    let audio,
      fallMode = false,
      fallSpeed = 0.04,
      interiorDepth = 0,
      interiorSpeed = 0.4,
      lastAudioUpdate = -Infinity,
      soundEnabled = false;
    const audioMixOverride = new URLSearchParams(location.search).get("audio");
    const useMobileAudioMix =
      audioMixOverride === "mobile" ||
      (audioMixOverride !== "desktop" &&
        (Boolean(navigator.userAgentData?.mobile) ||
          /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
          matchMedia("(pointer: coarse) and (max-width: 900px)").matches));
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
      const octaveDown = useMobileAudioMix ? 2 : 0.5;
      const outputBoost = useMobileAudioMix ? 2.2 : 1;

      master.gain.value = 0;
      drone.gain.value = 0.7;
      droneFilter.type = "lowpass";
      droneFilter.frequency.value = 150 * octaveDown;
      droneFilter.Q.value = 1.2;
      turbulenceFilter.type = "lowpass";
      turbulenceFilter.frequency.value = 180 * octaveDown;
      turbulenceFilter.Q.value = 0.65;
      shearFilter.type = "bandpass";
      shearFilter.frequency.value = 420 * octaveDown;
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
        oscillator.frequency.value = frequency * octaveDown;
        oscillator.detune.value = (Math.random() - 0.5) * 7;
        gain.gain.value = level;
        oscillator.connect(gain).connect(drone);
        oscillator.start();
      });

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
        octaveDown,
        outputBoost,
      };
    };
    const updateAudio = (immediate = false) => {
      if (!audio) return;
      const now = audio.context.currentTime;
      if (!immediate && fallMode && now - lastAudioUpdate < 0.06) return;
      lastAudioUpdate = now;
      const diskApproach = clamp(
        (AUDIO_FAR_DISTANCE - view.distance) /
          (AUDIO_FAR_DISTANCE - DISK_INNER_EDGE),
      );
      const smoothApproach = smooth(diskApproach);
      const rise = (Math.exp(smoothApproach * 4.6) - 1) / (Math.exp(4.6) - 1);
      const horizonDistance = clamp(
        (view.distance - MIN_DISTANCE) / (DISK_INNER_EDGE - MIN_DISTANCE),
      );
      const horizonFade = smooth(horizonDistance);
      const intensity = rise * horizonFade;
      const ambientFloor = 0.007 + 0.021 * horizonFade;
      const ramp = immediate ? 0.01 : 0.12;
      const target = (parameter, value) =>
        parameter.setTargetAtTime(value, now, ramp);
      const interiorSilence = Math.exp(-interiorDepth * 1.15);

      target(
        audio.master.gain,
        soundEnabled
          ? (ambientFloor + intensity * 0.54) *
              interiorSilence *
              audio.outputBoost
          : 0,
      );
      target(
        audio.droneFilter.frequency,
        (145 + intensity * 1050) * audio.octaveDown,
      );
      target(audio.turbulence.gain, 0.13 + intensity * 0.62);
      target(
        audio.turbulenceFilter.frequency,
        (170 + intensity * 1350) * audio.octaveDown,
      );
      target(audio.shear.gain, 0.015 + intensity * 0.7);
      target(
        audio.shearFilter.frequency,
        (380 + intensity * 1750) * audio.octaveDown,
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
      setTextureParameters(gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE);
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
    let previousTime = performance.now();
    const draw = (now) => {
      const dt = Math.min((now - previousTime) * 0.001, 0.05);
      previousTime = now;
      const ease = Math.min(1, dt * 5);
      if (fallMode) {
        if (view.distance > MIN_DISTANCE) {
          const proximity = clamp(
            (defaults.distance - view.distance) /
              (defaults.distance - MIN_DISTANCE),
          );
          fallSpeed = Math.min(
            0.4,
            fallSpeed + dt * (0.006 + 0.12 * proximity * proximity),
          );
          zoomBy(Math.exp(-dt * fallSpeed));
        }
        if (view.distance <= INTERIOR_HANDOFF) {
          const handoff = clamp(
            (INTERIOR_HANDOFF - view.distance) /
              (INTERIOR_HANDOFF - INTERIOR_HANDOFF_END),
          );
          const handoffEase = smooth(handoff);
          interiorSpeed = Math.min(
            0.65,
            Math.max(interiorSpeed, fallSpeed) + dt * 0.015,
          );
          interiorDepth += dt * interiorSpeed * handoffEase;
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
      gl.uniform1f(u.time, now * 0.001);
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
      const altitude = (view.distance - EVENT_HORIZON) * factor;
      view.distance =
        EVENT_HORIZON +
        clamp(
          altitude,
          MIN_DISTANCE - EVENT_HORIZON,
          MAX_DISTANCE - EVENT_HORIZON,
        );
    };
    const updateChrome = () => {
      const horizonDistance = clamp(
        (view.distance - MIN_DISTANCE) / (DISK_INNER_EDGE - MIN_DISTANCE),
      );
      const opacity = smooth(horizonDistance);
      document.body.style.setProperty("--ui-opacity", opacity.toFixed(3));
      document.body.classList.toggle("ui-hidden", opacity < 0.035);
    };
    const setFallMode = (enabled) => {
      fallMode = enabled;
      if (fallMode && view.distance <= MIN_DISTANCE + 0.002)
        view.distance = defaults.distance;
      fallSpeed = 0.04;
      interiorDepth = 0;
      interiorSpeed = 0.4;
      if (fallMode) {
        view.panX = 0;
        view.panY = 0;
        awakenAudio();
      } else {
        view.lookYaw = view.targetLookYaw = 0;
        view.lookPitch = view.targetLookPitch = 0;
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
        view.targetLookPitch = clamp(
          view.targetLookPitch + (point.y - old.y) * 0.0045,
          -1.5,
          1.5,
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
          view.targetPitch = clamp(view.targetPitch + dy * 0.0035, -1.42, 1.42);
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
