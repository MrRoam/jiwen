class PCMProcessor extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];this.phase=0;this.sum=0;this.count=0;this.enabled=true;this.port.onmessage=e=>{if(e.data==='flush'){this.flush();this.enabled=false;}};}
  flush(){if(!this.samples.length)return;const data=new Int16Array(this.samples);this.port.postMessage({buffer:data.buffer,endTime:this.packetEndTime},[data.buffer]);this.samples=[];}
  process(inputs){
    const channel=inputs[0]?.[0];if(!channel||!this.enabled)return true;
    const ratio=sampleRate/16000;
    for(let i=0;i<channel.length;i++){const sample=channel[i];this.packetEndTime=currentTime+(i+1)/sampleRate;this.sum+=sample;this.count++;this.phase++;if(this.phase>=ratio){const v=Math.max(-1,Math.min(1,this.sum/this.count));this.samples.push(v<0?v*32768:v*32767);this.phase-=ratio;this.sum=0;this.count=0;if(this.samples.length>=3200)this.flush();}}
    return true;
  }
}
registerProcessor('pcm-processor',PCMProcessor);
