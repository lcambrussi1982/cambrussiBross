(() => {
  // Cambrussi Bross — PRO + mobile + fogo (H) + vitamina (V) + vidas/retrocesso de fase
  const TILE = 48, SPR = 16, SCALE = TILE / SPR;
  const GRAVITY = 2000, MOVE_SPEED = 320, JUMP_V = 860, MAX_FALL = 1500, EPS = 0.0001;
  const MAX_LIVES = 5;

  // . vazio | X chão/parede | = plataforma | B tijolo | ? bloco ? | Q bloco ? usado
  // C moeda | E inimigo | F bandeira | P spawn | H fogo (perigo) | V bloco ? que solta VITAMINA (+1 vida)
  const SOLIDS = new Set(['X','=', 'B', '?', 'Q', 'V']);

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const overlay = document.getElementById('overlay');
  const overlayBox = overlay.querySelector('.box');
  const camera = { x:0, y:0, w:canvas.width, h:canvas.height };

  // ===== Input (teclado + toque) =====
  const keys = new Set(), wasPressed = new Set();
  const pressKey = k => { keys.add(k); wasPressed.add(k); };
  const releaseKey = k => keys.delete(k);
  const pressJump = () => { pressKey(' '); pressKey('w'); };
  const releaseJump = () => { releaseKey(' '); releaseKey('w'); };

  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (["arrowleft","arrowright","arrowup"," ","a","d","w","r"].includes(k)) e.preventDefault();
    keys.add(k); wasPressed.add(k);
  }, {passive:false});
  addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

  const tcButtons = document.querySelectorAll('.tc-btn');
  if (tcButtons.length){
    tcButtons.forEach(btn => {
      const code = btn.dataset.key;
      const down = e => {
        e.preventDefault();
        if (code === 'a') pressKey('a');
        else if (code === 'd') pressKey('d');
        else if (code === 'jump') pressJump();
        else if (code === 'r') pressKey('r');
      };
      const up = e => {
        e.preventDefault();
        if (code === 'a') releaseKey('a');
        else if (code === 'd') releaseKey('d');
        else if (code === 'jump') releaseJump();
        else if (code === 'r') releaseKey('r');
      };
      btn.addEventListener('pointerdown', down, {passive:false});
      btn.addEventListener('pointerup', up, {passive:false});
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
    });
    ['touchstart','touchmove','gesturestart'].forEach(ev => {
      document.addEventListener(ev, e => { if (e.target.closest('.touch-controls, #game')) e.preventDefault(); }, {passive:false});
    });
  }

  // ===== Loader =====
  const ASSETS = {
    images:{
      ground:"assets/img/tile_ground.png",
      platform:"assets/img/tile_platform.png",
      brick:"assets/img/tile_brick.png",
      qblock:"assets/img/tile_question.png",
      qused :"assets/img/tile_question_used.png",
      flag  :"assets/img/flag.png",
      player:"assets/img/player.png",
      enemy :"assets/img/enemy.png",
      coin  :"assets/img/coin.png",
      // vitamina será desenhada por código (sem sprite)
    },
    sfx:{
      jump:"assets/sfx/jump.wav",
      coin:"assets/sfx/coin.wav",
      stomp:"assets/sfx/stomp.wav",
      break:"assets/sfx/break.wav",
      flag:"assets/sfx/flag.wav",
    },
    levels:[
      "levels/level1.json",
      "levels/level2.json",
      "levels/level3.json"
    ]
  };
  const IM={}, SFX={}, LEVELS=[];
  const loadImage = src => new Promise(res=>{ const i=new Image(); i.onload=()=>res(i); i.src=src; });
  const loadAudio = src => { const a=new Audio(src); a.preload="auto"; return a; };
  async function loadAll(){
    for (const [k,src] of Object.entries(ASSETS.images)) IM[k]=await loadImage(src);
    for (const [k,src] of Object.entries(ASSETS.sfx)) SFX[k]=loadAudio(src);
    for (const url of ASSETS.levels){ const r=await fetch(url); LEVELS.push(await r.json()); }
  }

  // ===== Utils =====
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const rectsIntersect=(a,b)=>!(a.x+a.w<=b.x||a.x>=b.x+b.w||a.y+a.h<=b.y||a.y>=b.y+b.h);
  const showOverlay = html => { overlayBox.innerHTML=html; overlay.classList.add('show'); };
  const hideOverlay = () => overlay.classList.remove('show');
  const play = s => { if (SFX[s]) { SFX[s].currentTime=0; SFX[s].play().catch(()=>{}); } };

  // ===== Mundo =====
  class World{
    constructor(raw){
      this.w=raw[0].length; this.h=raw.length;
      this.tiles=new Array(this.w*this.h).fill('.');
      this.coins=[]; this.enemies=[]; this.hazards=[]; this.flag=null; this.spawn={x:TILE,y:TILE*4};
      for (let r=0;r<this.h;r++){
        for (let c=0;c<this.w;c++){
          const ch=raw[r][c]||'.'; const x=c*TILE, y=r*TILE;
          if (ch==='P') this.spawn={x, y:y-TILE};
          else if (ch==='C') this.coins.push(new Coin(x+18,y+18));
          else if (ch==='E') this.enemies.push(new Enemy(x+8,y+8));
          else if (ch==='F') this.flag={x:x+TILE/3,y:y-TILE*3,w:TILE/3,h:TILE*3};
          else if (ch==='H') this.hazards.push(new Fire(x+10, y+TILE-6));
          else if ('X=B?QV'.includes(ch)) this.setTile(c,r,ch);
        }
      }
      // (opcional) ajuste automático de ? inalcançáveis: desce até ficar bom
      this.ensureReachableBlocks = () => {
        const isReachable = (c, r) => this.getTile(c, r+1) === '.' && this.isSolidAt(c, r+2);
        const canMoveDown   = (c, r) => this.inBounds(c, r+1) && this.getTile(c, r+1) === '.';
        for (let r = 0; r < this.h; r++) for (let c = 0; c < this.w; c++){
          if (!['?','V'].includes(this.getTile(c,r))) continue;
          if (isReachable(c, r)) continue;
          let rr=r;
          while (rr+2<this.h && !isReachable(c, rr) && canMoveDown(c, rr)) rr++;
          if (isReachable(c, rr)) { this.setTile(c, r, '.'); this.setTile(c, rr, this.getTile(c, rr)==='.'? '?':'?'); }
        }
      };
      this.ensureReachableBlocks();
    }
    idx(c,r){return r*this.w+c}
    inBounds(c,r){return c>=0&&r>=0&&c<this.w&&r<this.h}
    getTile(c,r){return this.inBounds(c,r)?this.tiles[this.idx(c,r)]:'X'}
    setTile(c,r,v){this.tiles[this.idx(c,r)]=v}
    isSolidAt(c,r){return SOLIDS.has(this.getTile(c,r))}
    forEachSolidInAABB(x,y,w,h,fn){
      const c0=Math.floor(x/TILE), r0=Math.floor(y/TILE);
      const c1=Math.floor((x+w-EPS)/TILE), r1=Math.floor((y+h-EPS)/TILE);
      for (let r=r0;r<=r1;r++) for (let c=c0;c<=c1;c++) if (this.isSolidAt(c,r)) fn(c,r);
    }
    drawTiles(cam){
      const c0=Math.floor(cam.x/TILE), r0=Math.floor(cam.y/TILE);
      const c1=Math.floor((cam.x+cam.w)/TILE), r1=Math.floor((cam.y+cam.h)/TILE);
      for (let r=r0;r<=r1;r++){
        for (let c=c0;c<=c1;c++){
          const t=this.getTile(c,r); if (!SOLIDS.has(t)) continue;
          const x=c*TILE-cam.x, y=r*TILE-cam.y;
          let img=IM.ground; 
          if (t==='=') img=IM.platform;
          else if (t==='B') img=IM.brick;
          else if (t==='?' || t==='V') img=IM.qblock; // vitamina usa o mesmo visual do bloco ?
          else if (t==='Q') img=IM.qused;
          ctx.imageSmoothingEnabled=false;
          ctx.drawImage(img,0,0,img.width,img.height, Math.floor(x),Math.floor(y), TILE,TILE);
        }
      }
    }
  }

  // ===== Perigos (FOGO) =====
  class Fire{
    constructor(x,y){ this.x=x; this.y=y; this.t=0; this.w=28; this.h=28; }
    aabb(){ const h = this.h + Math.sin(this.t*8)*4; return { x:this.x-10, y:this.y - h, w:20, h:h }; }
    update(dt){ this.t += dt; }
    draw(cam){
      const bx = Math.floor(this.x - cam.x), by = Math.floor(this.y - cam.y);
      const flick = Math.sin(this.t*20)*2;
      ctx.fillStyle = "rgba(70,70,70,.9)"; ctx.fillRect(bx-8, by-4, 16, 6);
      ctx.beginPath(); ctx.moveTo(bx, by-4);
      ctx.bezierCurveTo(bx-10, by-20, bx-6, by-36+flick, bx, by-44);
      ctx.bezierCurveTo(bx+6, by-36-flick, bx+10, by-20, bx, by-4);
      ctx.closePath();
      const grd = ctx.createLinearGradient(bx, by-44, bx, by-4);
      grd.addColorStop(0, "#ffd54a"); grd.addColorStop(0.5, "#ff7a2a"); grd.addColorStop(1, "#ff3b3b");
      ctx.fillStyle = grd; ctx.fill();
    }
  }

  // ===== Coletáveis =====
  class Coin{
    constructor(x,y){ this.x=x; this.y=y; this.w=24; this.h=24; this.t=0; this.taken=false; }
    aabb(){return {x:this.x,y:this.y,w:this.w,h:this.h}}
    update(dt){ this.t+=dt; }
    draw(cam){
      if (this.taken) return;
      const frame=Math.floor(this.t*12)%4, sx=frame*12, sy=0, sw=12, sh=12;
      const dx=Math.floor(this.x-cam.x), dy=Math.floor(this.y-cam.y+Math.sin(this.t*6)*3);
      ctx.imageSmoothingEnabled=false; ctx.drawImage(IM.coin,sx,sy,sw,sh,dx,dy,sw*SCALE,sh*SCALE);
    }
    take(){ this.taken=true; }
  }

  // Vitamina (ganha vida) — desenhado por código
  const vitamins=[];
  class Vitamin{
    constructor(x,y){ this.x=x; this.y=y; this.w=20; this.h=20; this.t=0; this.taken=false; }
    aabb(){ return {x:this.x, y:this.y, w:this.w, h:this.h}; }
    update(dt){ this.t+=dt; }
    draw(cam){
      if (this.taken) return;
      const dx=Math.floor(this.x - cam.x), dy=Math.floor(this.y - cam.y + Math.sin(this.t*6)*3);
      // cápsula vermelho/branco
      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillStyle="#d32f2f"; ctx.fillRect(0,0,10,10);
      ctx.fillStyle="#ffffff"; ctx.fillRect(10,0,10,10);
      ctx.fillStyle="rgba(0,0,0,.18)"; ctx.fillRect(0,0,20,10);
      ctx.restore();
    }
  }

  // Efeitos
  const floatingCoins=[]; class FloatingCoin{
    constructor(x,y){ this.x=x; this.y=y; this.t=0; this.done=false; }
    update(dt){ this.t+=dt; this.y-=120*dt; if(this.t>0.5) this.done=true; }
    draw(cam){ const f=Math.floor(this.t*12)%4; const dx=Math.floor(this.x-cam.x), dy=Math.floor(this.y-cam.y);
      ctx.drawImage(IM.coin,f*12,0,12,12,dx,dy,12*SCALE,12*SCALE); }
  }

  const breakParticles=[]; class BreakParticle{
    constructor(x,y){ this.p=[]; for(let i=0;i<6;i++) this.p.push({x:x+16+Math.random()*16,y:y+16+Math.random()*16,vx:(Math.random()*2-1)*180,vy:-(200+Math.random()*120),t:0});
      this.done=false; }
    update(dt){ let alive=false; for(const o of this.p){ o.vy+=1200*dt; o.x+=o.vx*dt; o.y+=o.vy*dt; o.t+=dt; if (o.t<0.6) alive=true; } this.done=!alive; }
    draw(cam){ ctx.fillStyle="#a65a3c"; for(const o of this.p) ctx.fillRect(Math.floor(o.x-cam.x),Math.floor(o.y-cam.y),4,4); }
  }

  // ===== Player =====
  class Player{
    constructor(x,y,lives=3){ this.x=x; this.y=y; this.w=32; this.h=42; this.vx=0; this.vy=0; this.onGround=false; this.frame=0; this.animT=0; this.facing=1; this.score=0; this.deaths=0; this.won=false; this.spawn={x,y}; this.lives=lives; }
    aabb(){return {x:this.x,y:this.y,w:this.w,h:this.h}}
    centerX(){return this.x+this.w/2} centerY(){return this.y+this.h/2}
    resetToSpawn(){ this.x=this.spawn.x; this.y=this.spawn.y; this.vx=0; this.vy=0; this.onGround=false; }

    update(dt, world, queueDeath){
      if (this.won) return;
      const left=keys.has('a')||keys.has('arrowleft'), right=keys.has('d')||keys.has('arrowright');
      const wantJump=wasPressed.has('w')||wasPressed.has('arrowup')||wasPressed.has(' ');
      this.vx=0; if (left) this.vx-=MOVE_SPEED; if (right) this.vx+=MOVE_SPEED;
      if (right) this.facing=1; else if (left) this.facing=-1;
      if (wantJump && this.onGround){ this.vy=-JUMP_V; this.onGround=false; play('jump'); }

      // X
      this.vy=Math.min(this.vy+GRAVITY*dt, MAX_FALL);
      this.x+=this.vx*dt;
      if (this.vx!==0){
        const dir=Math.sign(this.vx);
        world.forEachSolidInAABB(this.x,this.y,this.w,this.h,(c,r)=>{
          const tx=c*TILE, ty=r*TILE, rect={x:tx,y:ty,w:TILE,h:TILE};
          if (rectsIntersect(this.aabb(),rect)){ if (dir>0) this.x=tx-this.w-EPS; else this.x=tx+TILE+EPS; }
        });
      }

      // Y
      const vyPrev=this.vy; this.y+=this.vy*dt; let grounded=false; let headBump=null;
      world.forEachSolidInAABB(this.x,this.y,this.w,this.h,(c,r)=>{
        const tx=c*TILE, ty=r*TILE, rect={x:tx,y:ty,w:TILE,h:TILE};
        if (rectsIntersect(this.aabb(),rect)){
          if (vyPrev>0){ this.y=ty-this.h-EPS; this.vy=0; grounded=true; }
          else if (vyPrev<0){ this.y=ty+TILE+EPS; this.vy=0; headBump={c,r,tile:world.getTile(c,r)}; }
        }
      });
      this.onGround=grounded;

      // Cabeçada especial -> moedas / tijolo / vitamina
      if (headBump){
        const {c,r,tile}=headBump;
        if (tile==='?' || tile==='V'){
          world.setTile(c,r,'Q');
          if (tile==='V'){
            // solta uma vitamina acima do bloco
            vitamins.push(new Vitamin(c*TILE+TILE/2-10, r*TILE-20));
          } else {
            floatingCoins.push(new FloatingCoin(c*TILE+TILE/2-6, r*TILE-6));
            this.score+=1; play('coin');
          }
        } else if (tile==='B'){
          world.setTile(c,r,'.'); breakParticles.push(new BreakParticle(c*TILE, r*TILE)); play('break');
        }
      }

      // Limites & queda
      this.x=clamp(this.x,0,world.w*TILE-this.w);
      if (this.y>world.h*TILE+TILE*2){ queueDeath(); }

      // Coletas
      for (const coin of world.coins) if (!coin.taken && rectsIntersect(this.aabb(),coin.aabb())){ coin.take(); this.score+=1; play('coin'); }
      for (const v of vitamins) if (!v.taken && rectsIntersect(this.aabb(), v.aabb())){
        v.taken=true; this.lives = Math.min(MAX_LIVES, this.lives + 1); play('coin');
      }

      // Inimigos
      for (const e of world.enemies) if (e.alive && rectsIntersect(this.aabb(),e.aabb())){
        const feet=this.y+this.h, top=e.y;
        if (vyPrev>0 && feet-top<28){ e.alive=false; this.vy=-JUMP_V*0.7; this.onGround=false; this.score+=3; play('stomp'); }
        else { queueDeath(); }
      }

      // Fogo
      for (const h of world.hazards){
        if (rectsIntersect(this.aabb(), h.aabb())){ queueDeath(); break; }
      }

      if (world.flag && rectsIntersect(this.aabb(),world.flag)){ this.won=true; play('flag'); }

      this.animT += dt * (Math.abs(this.vx)>1? 12: 4);
      this.frame = Math.floor(this.animT) % 3;
      wasPressed.clear();
    }

    draw(cam){
      const sx=this.frame*16, sy=0, sw=16, sh=24;
      const dx=Math.floor(this.x-cam.x), dy=Math.floor(this.y-cam.y);
      ctx.save(); ctx.imageSmoothingEnabled=false;
      if (this.facing<0){ ctx.translate(dx+sw*SCALE, dy); ctx.scale(-1,1); ctx.drawImage(IM.player,sx,sy,sw,sh,0,0,sw*SCALE,sh*SCALE); }
      else ctx.drawImage(IM.player,sx,sy,sw,sh,dx,dy,sw*SCALE,sh*SCALE);
      ctx.restore();
    }
  }

  class Enemy{
    constructor(x,y){ this.x=x; this.y=y; this.w=32; this.h=32; this.vx=80; this.vy=0; this.alive=true; this.t=0; }
    aabb(){return {x:this.x,y:this.y,w:this.w,h:this.h}}
    update(dt,world){
      if (!this.alive) return;
      this.vy=Math.min(this.vy+GRAVITY*dt,MAX_FALL);
      this.x+=this.vx*dt; let hit=false;
      world.forEachSolidInAABB(this.x,this.y,this.w,this.h,(c,r)=>{
        const tx=c*TILE, ty=r*TILE, rect={x:tx,y:ty,w:TILE,h:TILE};
        if (rectsIntersect(this.aabb(),rect)){ if (this.vx>0) this.x=tx-this.w-EPS; else this.x=tx+TILE+EPS; hit=true; }
      });
      if (hit) this.vx*=-1;

      const vyPrev=this.vy; this.y+=this.vy*dt; let grounded=false;
      world.forEachSolidInAABB(this.x,this.y,this.w,this.h,(c,r)=>{
        const tx=c*TILE, ty=r*TILE, rect={x:tx,y:ty,w:TILE,h:TILE};
        if (rectsIntersect(this.aabb(),rect)){
          if (vyPrev>0){ this.y=ty-this.h-EPS; this.vy=0; grounded=true; }
          else if (vyPrev<0){ this.y=ty+TILE+EPS; this.vy=0; }
        }
      });
      if (grounded){
        const dir=Math.sign(this.vx), aheadX=this.x+(dir>0? this.w+2:-2), footY=this.y+this.h+2;
        const c=Math.floor(aheadX/TILE), r=Math.floor(footY/TILE);
        if (!world.isSolidAt(c,r)) this.vx*=-1;
      }
      if (this.y>world.h*TILE+200) this.alive=false;
      this.t+=dt;
    }
    draw(cam){
      if (!this.alive) return;
      const frame=Math.floor(this.t*8)%2, sx=frame*16, sy=0, sw=16, sh=16;
      const dx=Math.floor(this.x-cam.x), dy=Math.floor(this.y-cam.y);
      ctx.imageSmoothingEnabled=false; ctx.drawImage(IM.enemy,sx,sy,sw,sh,dx,dy,sw*SCALE,sh*SCALE);
    }
  }

  // ===== Câmera, HUD, loop de jogo =====
  function updateCamera(p,world){ camera.x=clamp(p.centerX()-camera.w/2,0,world.w*TILE-camera.w); camera.y=clamp(p.centerY()-camera.h/2,0,world.h*TILE-camera.h); }
  function drawHUD(p,idx){ hud.innerHTML=`<strong>Cambrussi Bross</strong> · Fase: ${idx+1}/${LEVELS.length} · Moedas: ${p.score} · Mortes: ${p.deaths} · Vidas: ${p.lives}`; }

  let world, player, levelIndex=0, lives=3, deathQueued=false;

  function loadLevel(i){
    const raw=LEVELS[i];
    world=new World(raw);
    player=new Player(world.spawn.x,world.spawn.y,lives);
    // limpar itens de efeito
    vitamins.length = 0;
    floatingCoins.length = 0;
    breakParticles.length = 0;
  }

  const queueDeath = () => { deathQueued = true; };
  function loseLife(){
    player.deaths++;
    lives = Math.max(0, player.lives - 1);
    if (lives <= 0){
      // GAME OVER: volta pra fase 1 e reseta vidas
      levelIndex = 0;
      lives = 3;
      loadLevel(levelIndex);
      showOverlay(`Game Over!<small>Você voltou para a Fase 1 com 3 vidas. Toque/aperte qualquer tecla para continuar.</small>`);
    } else {
      // volta para a fase anterior (se existir)
      levelIndex = Math.max(0, levelIndex - 1);
      loadLevel(levelIndex);
    }
    deathQueued = false;
  }

  async function start(){
    await loadAll(); loadLevel(0);
    let last=performance.now();
    function frame(now){
      const dt=Math.min(1/30,(now-last)/1000); last=now;

      if (keys.has('r')){
        // reinicia a fase atual (mantendo vidas)
        player.score=0; player.deaths=0; player.won=false; hideOverlay(); loadLevel(levelIndex);
      }

      if (!player.won){
        player.update(dt,world,queueDeath);
        for (const e of world.enemies) e.update(dt,world);
        for (const c of world.coins) c.update(dt);
        for (const h of world.hazards) h.update(dt);
        for (const v of vitamins) v.update(dt);
        for (const fc of floatingCoins) fc.update(dt);
        for (const bp of breakParticles) bp.update(dt);
        for (let i=floatingCoins.length-1;i>=0;i--) if (floatingCoins[i].done) floatingCoins.splice(i,1);
        for (let i=breakParticles.length-1;i>=0;i--) if (breakParticles[i].done) breakParticles.splice(i,1);

        // Consumir morte
        if (deathQueued) loseLife();

        updateCamera(player,world);
      } else {
        showOverlay(`Fase concluída!<small>Moedas: ${player.score} · Mortes: ${player.deaths} · Toque/pressione para continuar</small>`);
        if (wasPressed.size>0){
          hideOverlay(); levelIndex++;
          if (levelIndex>=LEVELS.length){
            levelIndex=0;
            showOverlay(`Parabéns! Você zerou <em>Cambrussi Bross</em>!<small>Toque ↻ ou pressione R para recomeçar</small>`);
          } else {
            loadLevel(levelIndex);
          }
          player.won=false; wasPressed.clear();
        }
      }

      // Desenho
      ctx.clearRect(0,0,canvas.width,canvas.height);
      // nuvens
      ctx.globalAlpha=.35;
      for (let i=0;i<5;i++){
        const cx=(i*220 - (camera.x*.2) % (canvas.width+300)) - 100, cy=30+(i%3)*30;
        ctx.fillStyle="#fff"; ctx.beginPath();
        ctx.arc(cx,cy,20,0,Math.PI*2); ctx.arc(cx+20,cy+5,16,0,Math.PI*2); ctx.arc(cx-20,cy+8,14,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha=1;

      world.drawTiles(camera);
      for (const c of world.coins) c.draw(camera);
      if (world.flag){
        const dx=Math.floor(world.flag.x-camera.x), dy=Math.floor(world.flag.y-camera.y);
        ctx.imageSmoothingEnabled=false; ctx.drawImage(IM.flag,0,0,IM.flag.width,IM.flag.height,dx,dy,IM.flag.width*SCALE,IM.flag.height*SCALE);
      }
      for (const h of world.hazards) h.draw(camera);
      for (const v of vitamins) v.draw(camera);
      for (const e of world.enemies) e.draw(camera);
      for (const fc of floatingCoins) fc.draw(camera);
      for (const bp of breakParticles) bp.draw(camera);
      player.draw(camera);

      drawHUD(player,levelIndex);
      wasPressed.clear();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  start();
})();
