(function(){
  'use strict';
  /* ====== CONFIG ====== */
  const MODES = {
    study:         { label:'Study',         icon:'📚' },
    gaming:        { label:'Gaming',        icon:'🎮' },
    entertainment: { label:'Entertainment', icon:'🎬' },
    casual:        { label:'Casual',        icon:'☕' },
  };
  const AV_COLORS = ['#e11d48','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#f97316','#06b6d4','#6366f1','#14b8a6'];
  /* ====== STATE ====== */
  const S = { room:null, userId:null, username:'You', messages:[] };
  const roomId = location.pathname.replace(/.*\/room\//,'').replace(/\/$/,'');
  /* ====== DOM ====== */
  const $ = id => document.getElementById(id);
  const dom = {
    root:$('roomPage'), sky:$('skyBg'),
    details:$('roomDetails'), hdrName:$('hdrName'), hdrBadge:$('hdrBadge'), hdrDot:$('hdrDot'),
    videoWrap:$('videoWrapper'), placeholder:$('videoPlaceholder'),
    controls:$('videoControls'), container:$('videoContainer'),
    chatMsgs:$('chatMessages'), chatInput:$('chatInput'), chatOnline:$('chatOnline'),
    toasts:$('toastWrap'),
  };
  /* ====== INIT ====== */
  document.addEventListener('DOMContentLoaded', async ()=>{
    const tod = resolveTod();
    dom.root.dataset.theme = tod;
    dom.sky.style.backgroundImage = "url('/assets/"+tod+"/sky.png')";
    wireEvents();
    await fetchMe();
    await joinRoom();
  });
  function resolveTod(){
    try{if(typeof getTimeOfDay==='function')return getTimeOfDay()}catch(_){}
    var h=new Date().getHours();
    if(h>=6&&h<12)return'morning';if(h>=12&&h<17)return'afternoon';
    if(h>=17&&h<21)return'evening';return'night';
  }
  /* ====== EVENTS ====== */
  function wireEvents(){
    $('backBtn').onclick = ()=> location.href='/dashboard';
    $('leaveBtn').onclick = leaveRoom;
    $('loadUrlBtn').onclick = ()=> loadVideo($('urlInput').value.trim());
    $('urlInput').addEventListener('keydown', e=>{ if(e.key==='Enter') loadVideo($('urlInput').value.trim()); });
    $('sendBtn').onclick = sendMessage;
    dom.chatInput.addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} });
    // touch: show controls briefly
    dom.container.addEventListener('touchstart',()=>{
      dom.controls.classList.add('show');
      clearTimeout(dom.controls._t);
      dom.controls._t=setTimeout(()=>dom.controls.classList.remove('show'),3000);
    });
  }
  /* ====== API ====== */
  async function fetchMe(){
    try{
      var r=await fetch('/api/auth/me',{credentials:'include'});
      if(!r.ok)return;
      var d=await r.json(), u=d.user||d;
      S.userId=u.id||u._id||null; S.username=u.username||'You';
    }catch(_){}
  }
  async function joinRoom(){
    try{
      var r=await fetch('/api/rooms/'+roomId+'/join',{method:'POST',credentials:'include'});
      if(r.status===401){location.href='/';return;}
      if(r.status===404){toast('Room not found','error');setTimeout(()=>location.href='/dashboard',1500);return;}
      if(!r.ok)throw new Error();
      var d=await r.json();
      S.room=d.room;
      renderRoom();
    }catch(e){
      toast('Failed to join room','error');
    }
  }
  async function leaveRoom(){
    try{await fetch('/api/rooms/'+roomId+'/leave',{method:'POST',credentials:'include'});}catch(_){}
    location.href='/dashboard';
  }
  /* ====== RENDER ROOM ====== */
  function renderRoom(){
    var r=S.room; if(!r)return;
    var cfg=MODES[r.mode]||{label:r.mode||'Room',icon:'📺'};
    var bc='badge-'+(MODES[r.mode]?r.mode:'casual');
    // header
    dom.hdrName.textContent=r.roomName;
    dom.hdrBadge.className='mode-badge '+bc; dom.hdrBadge.textContent=cfg.icon+' '+cfg.label; dom.hdrBadge.style.display='';
    dom.hdrDot.className='status-dot status-'+(r.status||'active'); dom.hdrDot.style.display='';
    // details
    var parts=r.participants||[];
    dom.details.innerHTML=
      '<h2 class="rd-name">'+esc(r.roomName)+'</h2>'
      +(r.description?'<p class="rd-desc">'+esc(r.description)+'</p>':'')
      +'<div class="rd-meta">'
        +'<span class="mode-badge '+bc+'">'+cfg.icon+' '+cfg.label+'</span>'
        +'<span style="display:flex;align-items:center;gap:.3rem"><span class="status-dot status-'+(r.status||'active')+'"></span>'+esc(r.status||'active')+'</span>'
        +'<span class="rd-meta-sep">·</span>'
        +'<span>Hosted by <strong>'+esc(r.admin?r.admin.username:'—')+'</strong></span>'
        +'<span class="rd-meta-sep">·</span>'
        +'<span>👥 '+parts.length+'/'+(r.maxParticipants||10)+'</span>'
      +'</div>'
      +(r.tags&&r.tags.length?'<div class="rd-tags">'+r.tags.map(t=>'<span class="tag">#'+esc(t)+'</span>').join('')+'</div>':'')
      +renderAvatars(parts);
    dom.chatOnline.textContent=parts.length+' in room';
    // system msg
    addSystemMsg('You joined the room');
    // auto-load video if room has one
    if(r.video&&r.video.url){
      $('urlInput').value=r.video.url;
      loadVideo(r.video.url);
    }
  }
  function renderAvatars(list){
    if(!list.length)return'';
    var MAX=10,show=list.slice(0,MAX),extra=list.length-MAX;
    var h='<div class="rd-avatars">';
    show.forEach(p=>{
      var c=avColor(p.username), ini=(p.username||'?')[0].toUpperCase();
      h+='<div class="avatar-sm" style="background:'+c+'" title="'+esc(p.username)+'">'+ini+'</div>';
    });
    if(extra>0) h+='<div class="avatar-sm avatar-more">+'+extra+'</div>';
    return h+'</div>';
  }
  /* ====== VIDEO PLAYER ====== */
  var videoEl=null, isYT=false;
  function loadVideo(url){
    if(!url){toast('Enter a URL','error');return;}
    var ytId=extractYT(url);
    isYT=!!ytId;
    if(ytId){
      dom.videoWrap.innerHTML='<iframe src="https://www.youtube.com/embed/'+ytId+'?autoplay=0&rel=0" allow="autoplay;encrypted-media;fullscreen" allowfullscreen></iframe>';
      dom.controls.style.display='none';
    }else{
      dom.videoWrap.innerHTML='<video id="videoEl" preload="metadata"></video>';
      videoEl=$('videoEl');
      videoEl.src=url;
      dom.controls.style.display='';
      wireVideoControls();
    }
    dom.placeholder.remove();
    $('urlInput').value=url;
    // ===== SOCKET.IO HOOK — broadcast loaded URL to room =====
    // socket.emit('video-load', { roomId, url });
  }
  function wireVideoControls(){
    if(!videoEl)return;
    var prog=$('progressBar'),cur=$('curTime'),dur=$('durTime');
    var playBtn=$('playBtn'),muteBtn=$('muteBtn'),volBar=$('volBar'),fsBtn=$('fsBtn');
    videoEl.addEventListener('loadedmetadata',()=>{
      dur.textContent=fmtTime(videoEl.duration);
      prog.max=Math.floor(videoEl.duration*100)||1000;
      fillSlider(volBar,100,100);
    });
    videoEl.addEventListener('timeupdate',()=>{
      cur.textContent=fmtTime(videoEl.currentTime);
      prog.value=Math.floor(videoEl.currentTime*100);
      fillSlider(prog,prog.value,prog.max);
    });
    videoEl.addEventListener('play',()=>{playBtn.innerHTML=pauseSVG});
    videoEl.addEventListener('pause',()=>{playBtn.innerHTML=playSVG});
    videoEl.addEventListener('ended',()=>{playBtn.innerHTML=playSVG});
    playBtn.onclick=togglePlay;
    videoEl.onclick=togglePlay;
    prog.addEventListener('input',()=>{
      videoEl.currentTime=prog.value/100;
      fillSlider(prog,prog.value,prog.max);
    });
    muteBtn.onclick=()=>{
      videoEl.muted=!videoEl.muted;
      muteBtn.innerHTML=videoEl.muted?mutedSVG:volSVG;
    };
    volBar.addEventListener('input',()=>{
      videoEl.volume=volBar.value/100;
      videoEl.muted=videoEl.volume===0;
      muteBtn.innerHTML=videoEl.muted?mutedSVG:volSVG;
      fillSlider(volBar,volBar.value,100);
    });
    fsBtn.onclick=()=>{
      if(document.fullscreenElement)document.exitFullscreen();
      else dom.container.requestFullscreen().catch(()=>{});
    };
    // ===== SOCKET.IO HOOKS — sync play/pause/seek =====
    // videoEl.addEventListener('play', ()=> socket.emit('video-play',{ roomId, currentTime:videoEl.currentTime }));
    // videoEl.addEventListener('pause',()=> socket.emit('video-pause',{ roomId, currentTime:videoEl.currentTime }));
    // videoEl.addEventListener('seeked',()=> socket.emit('video-seek',{ roomId, currentTime:videoEl.currentTime }));
  }
  function togglePlay(){
    if(!videoEl)return;
    if(videoEl.paused)videoEl.play().catch(()=>{});else videoEl.pause();
  }
  function extractYT(url){
    var m=url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m?m[1]:null;
  }
  /* SVG strings for player buttons */
  var playSVG='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  var pauseSVG='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  var volSVG='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  var mutedSVG='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  function fillSlider(el,val,max){
    var pct=(val/max)*100;
    el.style.background='linear-gradient(to right,#fff '+pct+'%,rgba(255,255,255,.25) '+pct+'%)';
  }
  /* ====== CHAT ====== */
  function sendMessage(){
    var text=dom.chatInput.value.trim();
    if(!text)return;
    addMessage({username:S.username,text:text,self:true});
    dom.chatInput.value='';
    dom.chatInput.focus();
    // ===== SOCKET.IO HOOK — send message to room =====
    // socket.emit('chat-message', { roomId, username: S.username, text });
  }
  function addMessage(msg){
    S.messages.push(msg);
    var c=avColor(msg.username), ini=(msg.username||'?')[0].toUpperCase();
    var div=document.createElement('div');
    div.className='chat-msg';
    div.innerHTML=
      '<div class="msg-av" style="background:'+c+'">'+ini+'</div>'
      +'<div class="msg-body">'
        +'<div class="msg-head">'
          +'<span class="msg-name'+(msg.self?' self':'')+'">'+esc(msg.username)+'</span>'
          +'<span class="msg-ts">'+chatTs()+'</span>'
        +'</div>'
        +'<div class="msg-text">'+esc(msg.text)+'</div>'
      +'</div>';
    dom.chatMsgs.appendChild(div);
    dom.chatMsgs.scrollTop=dom.chatMsgs.scrollHeight;
  }
  function addSystemMsg(text){
    var div=document.createElement('div');
    div.className='chat-sys';
    div.textContent=text;
    dom.chatMsgs.appendChild(div);
    dom.chatMsgs.scrollTop=dom.chatMsgs.scrollHeight;
  }
  // ===== SOCKET.IO HOOKS — receive messages =====
  // socket.on('chat-message', msg => addMessage(msg));
  // socket.on('user-joined', d => { addSystemMsg(d.username+' joined'); updateParticipants(d.participants); });
  // socket.on('user-left',   d => { addSystemMsg(d.username+' left');   updateParticipants(d.participants); });
  /* ====== HELPERS ====== */
  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
  function fmtTime(s){if(isNaN(s))return'0:00';var m=Math.floor(s/60),sec=Math.floor(s%60);return m+':'+(sec<10?'0':'')+sec}
  function chatTs(){var d=new Date();return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')}
  function avColor(name){if(!name)return AV_COLORS[0];var h=0;for(var i=0;i<name.length;i++)h=name.charCodeAt(i)+((h<<5)-h);return AV_COLORS[Math.abs(h)%AV_COLORS.length]}
  function toast(msg,type){
    var el=document.createElement('div');el.className='toast toast-'+(type||'success');el.textContent=msg;
    dom.toasts.appendChild(el);
    setTimeout(()=>{el.classList.add('hiding');setTimeout(()=>el.remove(),300)},3200);
  }
})();