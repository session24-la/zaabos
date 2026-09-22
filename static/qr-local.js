(function(global){
  'use strict';

  // Local QR renderer for ZaabOS table-order links.
  // Fixed QR Model 2 Version 6 / ECC-L comfortably fits ZaabOS order URLs.
  // Rendering locally avoids third-party image hosts, so it works with ZaabOS'
  // strict Content-Security-Policy and on Safari/iPhone/iPad.
  const VERSION=6, SIZE=17+4*VERSION, DATA_CW=136, ECC_CW=18, BLOCKS=2;

  const EXP=new Uint8Array(512), LOG=new Uint8Array(256);
  (function(){
    let x=1;
    for(let i=0;i<255;i++){
      EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100)x^=0x11d;
    }
    for(let i=255;i<512;i++)EXP[i]=EXP[i-255];
  })();

  function gfMul(a,b){ return (!a||!b)?0:EXP[LOG[a]+LOG[b]]; }

  function rsGenerator(deg){
    let g=[1];
    for(let i=0;i<deg;i++){
      const n=new Array(g.length+1).fill(0);
      for(let j=0;j<g.length;j++){
        n[j]^=g[j];
        n[j+1]^=gfMul(g[j],EXP[i]);
      }
      g=n;
    }
    return g;
  }
  const GEN=rsGenerator(ECC_CW);

  function rsRemainder(data){
    const rem=new Uint8Array(ECC_CW);
    for(const b of data){
      const factor=b^rem[0];
      for(let i=0;i<ECC_CW-1;i++)rem[i]=rem[i+1]^gfMul(GEN[i+1],factor);
      rem[ECC_CW-1]=gfMul(GEN[ECC_CW],factor);
    }
    return Array.from(rem);
  }

  function pushBits(arr,val,len){
    for(let i=len-1;i>=0;i--)arr.push((val>>>i)&1);
  }

  function makeCodewords(text){
    const bytes=Array.from(new TextEncoder().encode(text));
    if(bytes.length>134)throw new Error('ZaabOS QR data is too long');

    const bits=[];
    pushBits(bits,0b0100,4); // byte mode
    pushBits(bits,bytes.length,8); // versions 1..9 use 8-bit byte count
    for(const b of bytes)pushBits(bits,b,8);

    const cap=DATA_CW*8;
    for(let i=0;i<4&&bits.length<cap;i++)bits.push(0);
    while(bits.length%8)bits.push(0);

    const data=[];
    for(let i=0;i<bits.length;i+=8){
      let b=0;
      for(let j=0;j<8;j++)b=(b<<1)|bits[i+j];
      data.push(b);
    }
    let pad=0;
    while(data.length<DATA_CW)data.push(pad++%2?0x11:0xec);

    const blockLen=DATA_CW/BLOCKS, blocks=[];
    for(let b=0;b<BLOCKS;b++){
      const d=data.slice(b*blockLen,(b+1)*blockLen);
      blocks.push({d,e:rsRemainder(d)});
    }

    const out=[];
    for(let i=0;i<blockLen;i++)for(const b of blocks)out.push(b.d[i]);
    for(let i=0;i<ECC_CW;i++)for(const b of blocks)out.push(b.e[i]);
    return out;
  }

  function formatBits(mask){
    const data=(0b01<<3)|mask; // ECC-L = 01
    let rem=data<<10;
    for(let i=14;i>=10;i--)if((rem>>>i)&1)rem^=0x537<<(i-10);
    return ((data<<10)|(rem&0x3ff))^0x5412;
  }

  function makeMatrix(text){
    const m=Array.from({length:SIZE},()=>Array(SIZE).fill(null));

    function setFinder(r,c){
      for(let dy=-1;dy<=7;dy++)for(let dx=-1;dx<=7;dx++){
        const y=r+dy,x=c+dx;
        if(y<0||y>=SIZE||x<0||x>=SIZE)continue;
        const core=dy>=0&&dy<=6&&dx>=0&&dx<=6;
        m[y][x]=core&&(dy===0||dy===6||dx===0||dx===6||(dy>=2&&dy<=4&&dx>=2&&dx<=4));
      }
    }
    setFinder(0,0); setFinder(0,SIZE-7); setFinder(SIZE-7,0);

    for(let i=8;i<SIZE-8;i++){
      if(m[6][i]===null)m[6][i]=(i%2===0);
      if(m[i][6]===null)m[i][6]=(i%2===0);
    }

    // Version 6 alignment pattern center.
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const d=Math.max(Math.abs(dx),Math.abs(dy));
      m[34+dy][34+dx]=(d!==1);
    }

    // Format information: ECC-L, mask 0.
    const fb=formatBits(0);
    for(let i=0;i<15;i++){
      const bit=((fb>>>i)&1)!==0;
      if(i<6)m[i][8]=bit;
      else if(i<8)m[i+1][8]=bit;
      else m[SIZE-15+i][8]=bit;

      if(i<8)m[8][SIZE-i-1]=bit;
      else if(i===8)m[8][7]=bit;
      else m[8][15-i-1]=bit;
    }
    m[SIZE-8][8]=true; // fixed dark module

    const bits=[];
    for(const b of makeCodewords(text))pushBits(bits,b,8);
    let bi=0, upward=true;

    for(let right=SIZE-1;right>=1;right-=2){
      if(right===6)right--;
      for(let k=0;k<SIZE;k++){
        const row=upward?SIZE-1-k:k;
        for(let j=0;j<2;j++){
          const col=right-j;
          if(m[row][col]!==null)continue;
          let bit=bi<bits.length?bits[bi++]:0;
          if(((row+col)&1)===0)bit^=1; // mask pattern 0
          m[row][col]=!!bit;
        }
      }
      upward=!upward;
    }
    return m;
  }

  function svgDataUrl(text,size){
    const m=makeMatrix(text), border=4, dim=SIZE+border*2;
    const px=Math.max(120,Math.min(480,Number(size||220)));
    let path='';
    for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){
      if(m[y][x])path+=`M${x+border} ${y+border}h1v1h-1z`;
    }
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  }

  global.zaabosQrDataUrl=svgDataUrl;
  // app.js defines qrImgUrl using an external image host. Replace it after
  // app.js loads so every existing QR modal uses the local renderer instead.
  global.qrImgUrl=function(text,size){return svgDataUrl(text,size);};
})(typeof window!=='undefined'?window:globalThis);
