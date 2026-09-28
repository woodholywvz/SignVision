const $ = id => document.getElementById(id);
let stream, recorder, chunks = [], clip, startedAt, timerId, phrases = [];
const message = text => { $('feedback').textContent = text; };
async function api(url, data) {
  const response = await fetch(url, {method:'POST', body:data});
  const payload = await response.json();
  if (!response.ok) throw Error(payload.detail || 'Ошибка запроса');
  return payload;
}
function optionHtml(includeUnknown=false) {
  return phrases.map(p => `<option value="${p.id}">${p.text}</option>`).join('') + (includeUnknown ? '<option value="unknown">Неизвестный жест</option>' : '');
}
async function refresh() {
  const config = await fetch('/api/config').then(r=>r.json()); phrases = config.phrases;
  $('phraseSelect').innerHTML = optionHtml();
  const total = Object.values(config.counts).reduce((a,b)=>a+b,0);
  $('datasetStatus').textContent = `${total} примеров в датасете`;
  $('totalCount').textContent = `${total} примеров`;
  $('phraseGrid').replaceChildren(...phrases.map((p,i)=>{
    const card=document.createElement('div'); card.className='phrase-card';
    const number=document.createElement('span'); number.textContent=String(i+1).padStart(2,'0');
    const title=document.createElement('strong'); title.textContent=p.text;
    const count=document.createElement('small'); count.textContent=`${config.counts[p.id]} записей`;
    card.append(number,title,count); return card;
  }));
}
$('cameraButton').onclick = async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{width:960,height:720},audio:false});
    $('preview').srcObject=stream; $('placeholder').hidden=true;
    $('cameraState').textContent='Подключена'; $('recordButton').disabled=false;
    $('cameraButton').hidden=true;
  } catch(e) { message(`Камера недоступна: ${e.message}`); }
};
$('recordButton').onclick = () => {
  const mime=['video/mp4','video/webm;codecs=vp9','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
  if (!mime) {message('Браузер не поддерживает запись видео'); return;}
  chunks=[]; clip=null; $('saveButton').disabled=true; startedAt=Date.now();
  recorder=new MediaRecorder(stream,{mimeType:mime});
  recorder.ondataavailable=e=>{if(e.data.size) chunks.push(e.data)};
  recorder.onstop=async()=>{
    clip=new Blob(chunks,{type:mime}); $('saveButton').disabled=false;
    $('recordBadge').classList.remove('visible'); clearInterval(timerId);
    $('stopButton').hidden=true; $('recordButton').hidden=false;
    const form=new FormData(); form.append('video',clip,`gesture.${mime.includes('mp4')?'mp4':'webm'}`);
    $('resultText').textContent='Анализ записи…';
    try {const result=await api('/api/recognize',form);
      $('resultText').textContent=result.text;
      $('resultDetail').textContent=`${result.reason} · ${result.frames} кадров${result.distance===null?'':` · расстояние ${result.distance.toFixed(3)}`}`;
      $('result').style.background=result.phrase_id?'#eaf7ed':'#f8f4eb';
    } catch(e) { $('resultText').textContent='Не удалось распознать'; $('resultDetail').textContent=e.message; }
  };
  recorder.start(); $('recordBadge').classList.add('visible'); $('recordButton').hidden=true; $('stopButton').hidden=false;
  timerId=setInterval(()=>{const s=Math.floor((Date.now()-startedAt)/1000);$('timer').textContent=`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;if(s>=8)$('stopButton').click()},200);
};
$('stopButton').onclick=()=>{if(recorder?.state==='recording')recorder.stop()};
$('saveButton').onclick=async()=>{
  if(!clip)return;const form=new FormData();form.append('phrase_id',$('phraseSelect').value);
  form.append('video',clip,`sample.${clip.type.includes('mp4')?'mp4':'webm'}`);
  try{message('Сохраняю пример…');const r=await api('/api/samples',form);message(`Сохранено: ${r.frames} кадров`);await refresh()}catch(e){message(e.message)}
};
$('sampleFile').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;const form=new FormData();form.append('phrase_id',$('phraseSelect').value);form.append('video',file);
  try{message('Обрабатываю видео…');const r=await api('/api/samples',form);message(`Пример добавлен: ${r.frames} кадров`);await refresh()}catch(err){message(err.message)}finally{e.target.value=''}
};
$('evalFiles').onchange=e=>{
  $('evalLabels').replaceChildren(...Array.from(e.target.files).map((file,i)=>{
    const row=document.createElement('div');row.className='eval-line';
    const name=document.createElement('span');name.textContent=file.name;
    const select=document.createElement('select');select.dataset.index=i;select.innerHTML=optionHtml(true);
    row.append(name,select);return row;
  })); $('evalButton').disabled=!e.target.files.length;
};
$('evalButton').onclick=async()=>{
  const form=new FormData();const files=Array.from($('evalFiles').files);
  files.forEach((file,i)=>{form.append('videos',file);form.append('phrase_ids',$(`evalLabels`).querySelector(`select[data-index="${i}"]`).value)});
  $('evalResult').textContent='Оцениваю видео…';
  try{const r=await api('/api/evaluate',form);const table=document.createElement('table');
    table.innerHTML='<thead><tr><th>Видео</th><th>Ожидалось</th><th>Получено</th><th>Итог</th></tr></thead>';
    const body=document.createElement('tbody');r.results.forEach(row=>{const tr=document.createElement('tr');
      [row.file,row.expected,row.predicted||row.error,row.correct?'✓':'✕'].forEach(value=>{const td=document.createElement('td');td.textContent=value;tr.append(td)});body.append(tr)});
    table.append(body);$('evalResult').replaceChildren(document.createTextNode(`Точность: ${r.correct}/${r.total} (${Math.round(r.accuracy*100)}%)`),table);
  }catch(e){$('evalResult').textContent=e.message}
};
refresh().catch(e=>message(e.message));
