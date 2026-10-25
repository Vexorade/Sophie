(()=>{
 const form=document.querySelector('#checkoutForm'),button=form.querySelector('button[type=submit]'),status=document.querySelector('#checkoutStatus'),availability=document.querySelector('#paymentAvailability');
 let config=null,busy=false;
 function ready(){return !!config&&(state.payment==='Transferencia'?config.transferEnabled:config.enabled);}
 function refresh(){button.disabled=busy||!state.payment||!ready();button.textContent=busy?'Preparando tu pedido…':state.payment==='Transferencia'?'Ver datos para transferir →':'Pagar con Mercado Pago →';availability.textContent=!config?'No pudimos consultar la disponibilidad del pago. Recargá la página.':!state.payment?'Elegí tu medio de pago.':!ready()?(state.payment==='Transferencia'?'Las transferencias todavía no están habilitadas.':'Los pagos online todavía no están habilitados.'):(config.mode==='test'&&state.payment!=='Transferencia'?'Modo de prueba: no se realizan cobros reales.':state.payment==='Mercado Pago'?'Seña del 50% con dinero disponible en tu cuenta de Mercado Pago.':'');}
 document.querySelectorAll('[data-pay]').forEach(b=>b.addEventListener('click',refresh));
 fetch('/api/checkout',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();config=await r.json();refresh();}).catch(refresh);
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;if(!form.reportValidity())return;if(!ready()){refresh();return;}
  if(!state.legs||models[state.model].fabricPending){status.textContent='Completá la selección del sillón y las patas.';return;}
  const customer=Object.fromEntries(new FormData(form));customer.shippingAccepted=form.elements.shippingAccepted.checked;
  const selection={model:state.model,fabric:state.fabric,color:state.color,side:state.side,legs:state.legs,payment:state.payment};
  const signature=JSON.stringify({selection,customer});let pending;
  try{pending=JSON.parse(sessionStorage.getItem('sophie-payment-attempt'));}catch{}
  if(!pending||pending.signature!==signature)pending={signature,requestId:crypto.randomUUID()};
  try{sessionStorage.setItem('sophie-payment-attempt',JSON.stringify(pending));}catch{}
  busy=true;refresh();status.textContent='Guardando tu pedido…';
  try{
   const response=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',requestId:pending.requestId,selection,customer})});
   const order=await response.json();
   if(!response.ok&&!order.id)throw Error(order.error||'No se pudo preparar el pago.');
   if(!order.id)throw Error('No se pudo identificar el pedido.');
   // Top-level navigation to our receipt. The payment link there requires a real click.
   window.location.assign('/pago.html?id='+encodeURIComponent(order.id));
  }catch(e){status.textContent=e.message||'No pudimos confirmar el resultado. Volvé a intentar con los mismos datos.';busy=false;refresh();}
 });refresh();
})();
