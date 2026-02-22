import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Save, Play, Pause, Trash2, FolderOpen, X, Download, Subtitles } from 'lucide-react';

// --- Types ---

interface Segment {
  start: number;
  end: number;
}

interface Selection {
  start: number;
  end: number;
  anchor: number;
  head?: number;
}

interface Subtitle {
  id: number;
  start: number; // seconds (source time)
  end: number;   // seconds (source time)
  text: string;
}

// --- SRT / VTT parsing ---

function parseSRT(content: string): Subtitle[] {
  const subs: Subtitle[] = [];
  // Normalize line endings
  const blocks = content.replace(/\r\n/g, '\n').trim().split(/\n\n+/);
  
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    
    // Find the timecode line (contains -->)
    let timeLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeLineIndex = i;
        break;
      }
    }
    if (timeLineIndex === -1) continue;
    
    const timeLine = lines[timeLineIndex];
    const match = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) continue;
    
    const start = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
    const end = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
    const text = lines.slice(timeLineIndex + 1).join('\n');
    
    subs.push({ id: subs.length + 1, start, end, text });
  }
  
  return subs;
}

function parseVTT(content: string): Subtitle[] {
  // Remove the WEBVTT header and parse like SRT
  const withoutHeader = content.replace(/^WEBVTT[^\n]*\n/, '').replace(/^NOTE[^\n]*\n(\n|.)*?\n\n/gm, '');
  return parseSRT(withoutHeader);
}

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function formatVTTTime(seconds: number): string {
  return formatSRTTime(seconds).replace(',', '.');
}

function exportSRT(subs: Subtitle[]): string {
  return subs
    .sort((a, b) => a.start - b.start)
    .map((sub, i) => `${i + 1}\n${formatSRTTime(sub.start)} --> ${formatSRTTime(sub.end)}\n${sub.text}`)
    .join('\n\n') + '\n';
}

function exportVTT(subs: Subtitle[]): string {
  return 'WEBVTT\n\n' + subs
    .sort((a, b) => a.start - b.start)
    .map((sub, i) => `${i + 1}\n${formatVTTTime(sub.start)} --> ${formatVTTTime(sub.end)}\n${sub.text}`)
    .join('\n\n') + '\n';
}

export default function VideoEditor() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0); // Virtual time
  
  // Editor state
  const [segments, setSegments] = useState<Segment[]>([]);
  const [waveformSamples, setWaveformSamples] = useState<number[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isGeneratingWaveform, setIsGeneratingWaveform] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState('');
  const [canvasWidth, setCanvasWidth] = useState(window.innerWidth);
  
  // Subtitle state
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [subtitleMode, setSubtitleMode] = useState(false); // true = subtitle editing mode
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [subtitleFormat, setSubtitleFormat] = useState<'srt' | 'vtt'>('srt');
  const [editingSubText, setEditingSubText] = useState<string | null>(null); // text being edited in input
  
  // Subtitle drag state
  const [dragState, setDragState] = useState<{
    type: 'move' | 'resize-end';
    subIndex: number;
    startX: number;
    originalStart: number;
    originalEnd: number;
  } | null>(null);
  
  // Calculate actual canvas width with browser limit safeguard
  const MAX_CANVAS_WIDTH = 16384;
  const actualCanvasWidth = Math.min(canvasWidth * zoomLevel, MAX_CANVAS_WIDTH);
  const effectiveZoom = actualCanvasWidth / canvasWidth;
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const selectionRepeatCount = useRef(0);
  const subTextInputRef = useRef<HTMLTextAreaElement>(null);
  const lastActiveSubIndex = useRef<number>(-1);

  // Find active subtitle at current playhead position
  const getActiveSubtitleIndex = useCallback((): number => {
    if (subtitles.length === 0) {
      lastActiveSubIndex.current = -1;
      return -1;
    }
    // currentTime is virtual time; get source time
    const { sourceTime } = getSourceFromVirtualFn(currentTime, segments);
    for (let i = 0; i < subtitles.length; i++) {
      if (sourceTime >= subtitles[i].start && sourceTime <= subtitles[i].end) {
        lastActiveSubIndex.current = i;
        return i;
      }
    }
    // Playhead is between subtitles — keep last active if still valid
    if (lastActiveSubIndex.current >= 0 && lastActiveSubIndex.current < subtitles.length) {
      return lastActiveSubIndex.current;
    }
    return -1;
  }, [subtitles, currentTime, segments]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  // Handle window resize to update canvas width
  useEffect(() => {
    const handleResize = () => {
      setCanvasWidth(window.innerWidth);
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Load video file
  const handleFileOpen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      console.log('File selected:', file.name, file.type, file.size);
      setDebugInfo(`File: ${file.name}, Type: ${file.type}, Size: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
      setError(null);
      setVideoFile(file);
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      setSegments([]);
      setWaveformSamples([]);
      setSelection(null);
    } else {
      setDebugInfo('No file selected');
    }
  };

  // Handle video errors
  const handleVideoError = () => {
    const video = videoRef.current;
    if (video && video.error) {
      const errorMessages: { [key: number]: string } = {
        1: 'MEDIA_ERR_ABORTED - Loading aborted',
        2: 'MEDIA_ERR_NETWORK - Network error',
        3: 'MEDIA_ERR_DECODE - Decoding error (unsupported format)',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - Format not supported'
      };
      const errorMsg = errorMessages[video.error.code] || `Unknown error (code: ${video.error.code})`;
      setError(errorMsg);
      console.error('Video error details:', errorMsg);
    }
  };

  // Generate waveform when video loads
  const handleVideoLoaded = () => {
    const video = videoRef.current;
    if (!video) return;
    console.log('Video loaded! Duration:', video.duration, 'Ready state:', video.readyState);
    setDebugInfo(prev => prev + ' | Video loaded successfully');
    setSegments([{ start: 0, end: video.duration }]);
    setError(null);
  };

  // Trigger waveform generation when file changes
  useEffect(() => {
    if (videoFile) {
      generateWaveform();
    }
  }, [videoFile]);

  // Generate waveform visualization using Web Audio API
  const generateWaveform = async () => {
    if (!videoFile) return;
    
    console.log('Starting waveform generation...');
    setIsGeneratingWaveform(true);

    try {
      const arrayBuffer = await videoFile.arrayBuffer();
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      const channelData = audioBuffer.getChannelData(0);
      const samplesPerSec = 50; 
      const totalSamples = Math.floor(audioBuffer.duration * samplesPerSec);
      const step = Math.floor(channelData.length / totalSamples);
      const samples = [];

      for (let i = 0; i < totalSamples; i++) {
        let sum = 0;
        const start = i * step;
        const end = Math.min(start + step, channelData.length);
        
        for (let j = start; j < end; j++) {
          sum += channelData[j] * channelData[j];
        }
        
        samples.push(Math.sqrt(sum / (end - start)));
      }

      console.log('Samples generated:', samples.length);

      const max = Math.max(...samples);
      const normalized = samples.map(s => max > 0 ? s / max : 0);
      
      setWaveformSamples(normalized);
      setDebugInfo(prev => prev + ' | Waveform generated via AudioBuffer');
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error generating waveform:', err);
      setError('Waveform generation failed: ' + message);
      setWaveformSamples([]);
    }
    
    setIsGeneratingWaveform(false);
  };

  // Helper to get total duration from segments
  const getVirtualDuration = () => {
    return segments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);
  };

  // Pure function version for use in callbacks that need specific segments
  function getSourceFromVirtualFn(vTime: number, segs: Segment[]): { sourceTime: number; segmentIndex: number } {
    let accumulated = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const segDuration = seg.end - seg.start;
      if (vTime >= accumulated && vTime <= accumulated + segDuration + 0.001) {
        return { 
          sourceTime: seg.start + (vTime - accumulated),
          segmentIndex: i 
        };
      }
      accumulated += segDuration;
    }
    if (segs.length > 0) {
      return { sourceTime: segs[segs.length - 1].end, segmentIndex: segs.length - 1 };
    }
    return { sourceTime: 0, segmentIndex: -1 };
  }

  // Convert source time to virtual time
  function getVirtualFromSource(sourceTime: number, segs: Segment[]): number {
    let accumulated = 0;
    for (const seg of segs) {
      if (sourceTime >= seg.start && sourceTime <= seg.end) {
        return accumulated + (sourceTime - seg.start);
      }
      accumulated += (seg.end - seg.start);
    }
    return accumulated; // past end
  }

  // Draw waveform
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    if (waveformSamples.length === 0 || segments.length === 0) {
      ctx.fillStyle = '#4b5563';
      ctx.fillRect(0, height / 2 - 2, width, 4);
      return;
    }

    const virtualDuration = getVirtualDuration();
    if (virtualDuration === 0) return;

    const samplesPerSec = 50;
    let currentX = 0;

    // Draw segments
    segments.forEach(seg => {
      const segDuration = seg.end - seg.start;
      const segWidth = (segDuration / virtualDuration) * width;
      
      const startSampleIndex = Math.floor(seg.start * samplesPerSec);
      const endSampleIndex = Math.floor(seg.end * samplesPerSec);
      const segmentSamples = waveformSamples.slice(startSampleIndex, endSampleIndex);
      
      ctx.fillStyle = '#3b82f6';
      if (segmentSamples.length > 0) {
        const barWidth = segWidth / segmentSamples.length;
        segmentSamples.forEach((value, i) => {
          const barHeight = value * (height * 0.8);
          const x = currentX + (i * barWidth);
          const y = (height / 2) - (barHeight / 2);
          ctx.fillRect(x, y, Math.max(1, barWidth + 0.5), barHeight);
        });
      }
      
      if (currentX > 0) {
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(currentX, 0, 2, height);
      }

      currentX += segWidth;
    });

    // Draw subtitle rectangles on the waveform
    if (subtitles.length > 0) {
      const activeIdx = getActiveSubtitleIndex();
      const { sourceTime: playheadSource } = getSourceFromVirtualFn(currentTime, segments);
      
      subtitles.forEach((sub, idx) => {
        // Convert subtitle source times to virtual positions on canvas
        const subStartV = getVirtualFromSource(sub.start, segments);
        const subEndV = getVirtualFromSource(sub.end, segments);
        
        const startX = (subStartV / virtualDuration) * width;
        const endX = (subEndV / virtualDuration) * width;
        const rectWidth = Math.max(2, endX - startX);
        
        // Active subtitle is brighter
        const isActive = idx === activeIdx;
        if (isActive) {
          ctx.fillStyle = 'rgba(168, 162, 158, 0.5)'; // brighter gray
        } else {
          ctx.fillStyle = 'rgba(120, 113, 108, 0.35)'; // dimmer gray
        }
        ctx.fillRect(startX, 0, rectWidth, height);
        
        // Border
        ctx.strokeStyle = isActive ? 'rgba(214, 211, 209, 0.7)' : 'rgba(168, 162, 158, 0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(startX, 0, rectWidth, height);
        
        // Draw subtitle text if there's enough space
        if (rectWidth > 20) {
          ctx.fillStyle = isActive ? '#ffffff' : 'rgba(255,255,255,0.6)';
          ctx.font = '10px sans-serif';
          ctx.textBaseline = 'bottom';
          const displayText = sub.text.replace(/\n/g, ' ');
          const maxChars = Math.floor(rectWidth / 6);
          const truncated = displayText.length > maxChars ? displayText.substring(0, maxChars) + '…' : displayText;
          ctx.fillText(truncated, startX + 3, height - 4);
        }
      });
    }

    // Draw selection
    if (selection) {
      const startX = (selection.start / virtualDuration) * width;
      const endX = (selection.end / virtualDuration) * width;
      
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.fillRect(startX, 0, endX - startX, height);
      
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, height);
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, height);
      ctx.stroke();
    }

    // Draw playhead
    const playheadX = (currentTime / virtualDuration) * width;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

  }, [waveformSamples, currentTime, segments, selection, actualCanvasWidth, subtitles, subtitleMode]);

  // Convert virtual time to source time and segment index
  const getSourceFromVirtual = (vTime: number): { sourceTime: number; segmentIndex: number } => {
    return getSourceFromVirtualFn(vTime, segments);
  };

  // Update current time
  const handleTimeUpdate = () => {
    if (!videoRef.current || segments.length === 0) return;
    
    const videoTime = videoRef.current.currentTime;
    
    let virtualTimeAccumulator = 0;
    let activeSegmentIndex = -1;
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (videoTime >= seg.start - 0.1 && videoTime <= seg.end + 0.1) {
        activeSegmentIndex = i;
        const offset = Math.max(0, Math.min(seg.end - seg.start, videoTime - seg.start));
        setCurrentTime(virtualTimeAccumulator + offset);
        break;
      }
      virtualTimeAccumulator += (seg.end - seg.start);
    }
    
    if (activeSegmentIndex === -1) {
      const nextSeg = segments.find(s => s.start > videoTime + 0.1);
      if (nextSeg) {
        videoRef.current.currentTime = nextSeg.start;
      } else {
        if (isPlaying) {
          setIsPlaying(false);
          videoRef.current.pause();
        }
      }
    } else {
      const seg = segments[activeSegmentIndex];
      if (videoTime >= seg.end - 0.05) {
        if (activeSegmentIndex < segments.length - 1) {
          const nextSeg = segments[activeSegmentIndex + 1];
          videoRef.current.currentTime = nextSeg.start;
        } else {
          setIsPlaying(false);
          videoRef.current.pause();
        }
      }
    }
  };

  // Playback controls
  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  // Seek functions
  const seekVirtual = (delta: number) => {
    const vDuration = getVirtualDuration();
    const newVirtual = Math.max(0, Math.min(vDuration, currentTime + delta));
    
    const { sourceTime } = getSourceFromVirtual(newVirtual);
    
    if (videoRef.current) {
      videoRef.current.currentTime = sourceTime;
      setCurrentTime(newVirtual);
    }
  };

  const seekToVirtualTime = (vTime: number) => {
    const vDuration = getVirtualDuration();
    const clamped = Math.max(0, Math.min(vDuration, vTime));
    const { sourceTime } = getSourceFromVirtual(clamped);
    if (videoRef.current) {
      videoRef.current.currentTime = sourceTime;
      setCurrentTime(clamped);
    }
  };

  const seekToSourceTime = (sTime: number) => {
    const vTime = getVirtualFromSource(sTime, segments);
    seekToVirtualTime(vTime);
  };

  const seekBackward = () => seekVirtual(-0.4);
  const seekForward = () => seekVirtual(0.4);
  const seekToStart = () => seekVirtual(-currentTime);

  // Click on waveform to seek
  const handleWaveformClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || segments.length === 0) return;
    if (dragState) return; // Don't seek while dragging
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const clickVirtualTime = percentage * getVirtualDuration();
    
    const { sourceTime } = getSourceFromVirtual(clickVirtualTime);
    
    if (videoRef.current) {
      videoRef.current.currentTime = sourceTime;
      setCurrentTime(clickVirtualTime);
    }
  };
  
  // --- Subtitle drag handling on canvas ---
  const handleWaveformMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!subtitleMode || !canvasRef.current || subtitles.length === 0) return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = canvas.width;
    const virtualDuration = getVirtualDuration();
    if (virtualDuration === 0) return;
    
    const clickVTime = (x / rect.width) * virtualDuration;
    
    // Check if clicking on a subtitle rectangle
    for (let i = 0; i < subtitles.length; i++) {
      const sub = subtitles[i];
      const subStartV = getVirtualFromSource(sub.start, segments);
      const subEndV = getVirtualFromSource(sub.end, segments);
      
      const startX = (subStartV / virtualDuration) * rect.width;
      const endX = (subEndV / virtualDuration) * rect.width;
      
      // Check if near right edge (resize handle, 8px zone)
      if (Math.abs(e.clientX - rect.left - endX) < 8 && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        e.preventDefault();
        setDragState({
          type: 'resize-end',
          subIndex: i,
          startX: e.clientX,
          originalStart: sub.start,
          originalEnd: sub.end,
        });
        return;
      }
      
      // Check if inside subtitle rectangle (move)
      if (x >= startX && x <= endX) {
        e.preventDefault();
        setDragState({
          type: 'move',
          subIndex: i,
          startX: e.clientX,
          originalStart: sub.start,
          originalEnd: sub.end,
        });
        return;
      }
    }
  };

  // Mouse move/up for subtitle dragging
  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const virtualDuration = getVirtualDuration();
      if (virtualDuration === 0) return;

      const dx = e.clientX - dragState.startX;
      const pixelsPerSecond = rect.width / virtualDuration;
      const deltaTime = dx / pixelsPerSecond;

      setSubtitles(prev => {
        const updated = [...prev];
        const sub = { ...updated[dragState.subIndex] };
        
        if (dragState.type === 'move') {
          const duration = dragState.originalEnd - dragState.originalStart;
          let newStart = dragState.originalStart + deltaTime;
          let newEnd = newStart + duration;
          
          // Clamp to video bounds
          if (newStart < 0) { newStart = 0; newEnd = duration; }
          
          // Prevent overlap with neighbors
          const prevSub = dragState.subIndex > 0 ? updated[dragState.subIndex - 1] : null;
          const nextSub = dragState.subIndex < updated.length - 1 ? updated[dragState.subIndex + 1] : null;
          if (prevSub && newStart < prevSub.end) {
            newStart = prevSub.end;
            newEnd = newStart + duration;
          }
          if (nextSub && newEnd > nextSub.start) {
            newEnd = nextSub.start;
            newStart = newEnd - duration;
          }
          
          sub.start = newStart;
          sub.end = newEnd;
        } else if (dragState.type === 'resize-end') {
          let newEnd = dragState.originalEnd + deltaTime;
          // Minimum duration 0.1s
          if (newEnd < sub.start + 0.1) newEnd = sub.start + 0.1;
          // Prevent overlap with next
          const nextSub = dragState.subIndex < updated.length - 1 ? updated[dragState.subIndex + 1] : null;
          if (nextSub && newEnd > nextSub.start) newEnd = nextSub.start;
          sub.end = newEnd;
        }
        
        updated[dragState.subIndex] = sub;
        return updated;
      });
    };

    const handleMouseUp = () => {
      setDragState(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, segments]);

  // Selection handling
  const handleSelection = (direction: 1 | -1, stepMultiplier: number = 1) => {
    const baseStep = 0.04;
    const step = baseStep * stepMultiplier;
    
    if (!selection) {
      const start = currentTime;
      const end = Math.max(0, Math.min(getVirtualDuration(), currentTime + (direction * step)));
      setSelection({ start: Math.min(start, end), end: Math.max(start, end), anchor: start });
    } else {
      const anchor = selection.anchor !== undefined ? selection.anchor : selection.start;
      
      let head = (selection.head !== undefined) ? selection.head : (direction > 0 ? selection.end : selection.start);
      
      const newHead = Math.max(0, Math.min(getVirtualDuration(), head + (direction * step)));
      
      setSelection({
        start: Math.min(anchor, newHead),
        end: Math.max(anchor, newHead),
        anchor: anchor,
        head: newHead
      });
    }
  };

  // Delete selection
  const handleDelete = () => {
    if (!selection) return;
    
    const vStart = selection.start;
    const vEnd = selection.end;
    
    const newSegments: Segment[] = [];
    let accumulated = 0;
    
    segments.forEach(seg => {
      const segStartV = accumulated;
      const segEndV = accumulated + (seg.end - seg.start);
      
      if (segEndV <= vStart || segStartV >= vEnd) {
        newSegments.push(seg);
      } else {
        if (segStartV < vStart) {
          newSegments.push({
            start: seg.start,
            end: seg.start + (vStart - segStartV)
          });
        }
        if (segEndV > vEnd) {
          newSegments.push({
            start: seg.start + (vEnd - segStartV),
            end: seg.end
          });
        }
      }
      accumulated += (seg.end - seg.start);
    });
    
    setSegments(newSegments);
    setSelection(null);
    
    let newSourceTime = 0;
    let newAcc = 0;
    let found = false;
    for (const seg of newSegments) {
       const segDur = seg.end - seg.start;
       if (vStart <= newAcc + segDur) {
         newSourceTime = seg.start + (vStart - newAcc);
         found = true;
         break;
       }
       newAcc += segDur;
    }
    if (!found && newSegments.length > 0) newSourceTime = newSegments[newSegments.length-1].end;
    
    if (videoRef.current) {
      videoRef.current.currentTime = newSourceTime;
    }
    setCurrentTime(vStart);
  };

  // Auto-scroll logic
  useEffect(() => {
    if (!scrollContainerRef.current || segments.length === 0) return;
    
    const container = scrollContainerRef.current;
    const vDuration = getVirtualDuration();
    if (vDuration === 0) return;
    
    const waveformWidth = actualCanvasWidth;
    const playheadX = (currentTime / vDuration) * waveformWidth;
    
    const scrollLeft = container.scrollLeft;
    const clientWidth = container.clientWidth;
    
    if (playheadX < scrollLeft || playheadX > scrollLeft + clientWidth) {
      container.scrollLeft = playheadX - (clientWidth / 2);
    }
  }, [currentTime, actualCanvasWidth, segments]);

  // --- Subtitle functions ---

  const handleSubtitleFileOpen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content !== 'string') return;
      
      const isVTT = file.name.endsWith('.vtt');
      const parsed = isVTT ? parseVTT(content) : parseSRT(content);
      
      if (parsed.length === 0) {
        setError('No subtitles found in file');
        return;
      }
      
      setSubtitles(parsed);
      setSubtitleFile(file);
      setSubtitleFormat(isVTT ? 'vtt' : 'srt');
      setSubtitleMode(true);
      setDebugInfo(`Subtitle file loaded: ${parsed.length} cues`);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSubtitleSave = () => {
    if (subtitles.length === 0 || !subtitleFile) return;
    
    const content = subtitleFormat === 'vtt' ? exportVTT(subtitles) : exportSRT(subtitles);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = subtitleFile.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleSubtitleExport = () => {
    if (subtitles.length === 0) return;
    
    const content = subtitleFormat === 'vtt' ? exportVTT(subtitles) : exportSRT(subtitles);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    const baseName = subtitleFile 
      ? subtitleFile.name.replace(/\.[^.]+$/, '') 
      : 'subtitles';
    link.download = `${baseName}_edited.${subtitleFormat}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleCloseSubtitles = () => {
    setSubtitles([]);
    setSubtitleFile(null);
    setSubtitleMode(false);
    setEditingSubText(null);
  };

  // Play active subtitle and stop at its end
  const playActiveSub = () => {
    const idx = getActiveSubtitleIndex();
    if (idx === -1 || !videoRef.current) return;
    
    const sub = subtitles[idx];
    seekToSourceTime(sub.start);
    
    videoRef.current.play();
    setIsPlaying(true);
    
    // Set up a listener to stop at the subtitle end
    const checkEnd = () => {
      if (!videoRef.current) return;
      if (videoRef.current.currentTime >= sub.end - 0.03) {
        videoRef.current.pause();
        setIsPlaying(false);
        videoRef.current.removeEventListener('timeupdate', checkEnd);
      }
    };
    videoRef.current.addEventListener('timeupdate', checkEnd);
  };

  // Insert new subtitle at playhead
  const insertSubtitleAtPlayhead = () => {
    const { sourceTime } = getSourceFromVirtual(currentTime);
    const defaultDuration = 2.0;
    let newEnd = sourceTime + defaultDuration;
    
    // Sort subtitles to find insertion point
    const sorted = [...subtitles].sort((a, b) => a.start - b.start);
    
    // Check for overlap and adjust
    for (const sub of sorted) {
      if (sourceTime < sub.end && newEnd > sub.start) {
        // Overlap - clamp end to next sub start
        if (sourceTime < sub.start) {
          newEnd = sub.start;
        } else {
          // Can't insert here, it overlaps
          setError('Cannot insert subtitle here: overlaps with existing subtitle');
          return;
        }
      }
    }
    
    if (newEnd - sourceTime < 0.1) {
      setError('Not enough space to insert subtitle here');
      return;
    }
    
    const newSub: Subtitle = {
      id: Math.max(0, ...subtitles.map(s => s.id)) + 1,
      start: sourceTime,
      end: newEnd,
      text: '',
    };
    
    const updated = [...subtitles, newSub].sort((a, b) => a.start - b.start);
    setSubtitles(updated);
  };

  // Set active subtitle start/end at playhead
  const setActiveSubStart = () => {
    const idx = getActiveSubtitleIndex();
    if (idx === -1) return;
    const { sourceTime } = getSourceFromVirtual(currentTime);
    
    setSubtitles(prev => {
      const updated = [...prev];
      const sub = { ...updated[idx] };
      // Can't set start past end
      if (sourceTime >= sub.end) return prev;
      // Can't overlap previous
      const prevSub = idx > 0 ? updated[idx - 1] : null;
      if (prevSub && sourceTime < prevSub.end) return prev;
      sub.start = sourceTime;
      updated[idx] = sub;
      return updated;
    });
  };

  const setActiveSubEnd = () => {
    const idx = getActiveSubtitleIndex();
    if (idx === -1) return;
    const { sourceTime } = getSourceFromVirtual(currentTime);
    
    setSubtitles(prev => {
      const updated = [...prev];
      const sub = { ...updated[idx] };
      // Can't set end before start
      if (sourceTime <= sub.start) return prev;
      // Can't overlap next
      const nextSub = idx < updated.length - 1 ? updated[idx + 1] : null;
      if (nextSub && sourceTime > nextSub.start) return prev;
      sub.end = sourceTime;
      updated[idx] = sub;
      return updated;
    });
  };

  // Delete active subtitle
  const deleteActiveSub = () => {
    const idx = getActiveSubtitleIndex();
    if (idx === -1) return;
    setSubtitles(prev => prev.filter((_, i) => i !== idx));
    setEditingSubText(null);
  };

  // Navigate to prev/next subtitle
  const goToNextSub = () => {
    if (subtitles.length === 0) return;
    const sorted = [...subtitles].sort((a, b) => a.start - b.start);
    const { sourceTime } = getSourceFromVirtual(currentTime);
    const next = sorted.find(s => s.start > sourceTime + 0.05);
    if (next) seekToSourceTime(next.start);
  };

  const goToPrevSub = () => {
    if (subtitles.length === 0) return;
    const sorted = [...subtitles].sort((a, b) => a.start - b.start);
    const { sourceTime } = getSourceFromVirtual(currentTime);
    // Find last subtitle whose start is before current position
    let prev: Subtitle | null = null;
    for (const s of sorted) {
      if (s.start < sourceTime - 0.05) prev = s;
    }
    if (prev) seekToSourceTime(prev.start);
  };

  // Sync editing text with active subtitle
  useEffect(() => {
    if (!subtitleMode) {
      setEditingSubText(null);
      return;
    }
    const idx = getActiveSubtitleIndex();
    if (idx >= 0) {
      setEditingSubText(subtitles[idx].text);
    } else {
      setEditingSubText(null);
    }
  }, [subtitleMode, currentTime, subtitles.length]);

  const handleSubTextChange = (text: string) => {
    setEditingSubText(text);
    const idx = getActiveSubtitleIndex();
    if (idx >= 0) {
      setSubtitles(prev => {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], text };
        return updated;
      });
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Allow typing in textarea for subtitle editing
      const tag = (e.target as HTMLElement).tagName;
      const isInTextarea = tag === 'TEXTAREA';
      
      // In subtitle mode with textarea focus, only handle specific shortcuts
      if (isInTextarea) {
        // Ctrl+S to save subtitles even in textarea
        if (e.ctrlKey && e.key === 's') {
          e.preventDefault();
          handleSubtitleSave();
          return;
        }
        // Let all other keys go to textarea
        return;
      }
      
      if (tag === 'INPUT') return;

      // Ctrl+S: save subtitles
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        if (subtitleMode) {
          handleSubtitleSave();
        }
        return;
      }

      // Subtitle-specific shortcuts (override some keys in subtitle mode)
      if (subtitleMode) {
        const key = e.key;
        
        // Numpad keys & subtitle shortcuts
        switch (key) {
          case '4': // Numpad 4: 100ms back (or Ctrl+Numpad4: 1 frame back)
            if (e.location === 3) { // KeyboardEvent.DOM_KEY_LOCATION_NUMPAD
              e.preventDefault();
              if (e.ctrlKey) {
                seekVirtual(-0.033);
              } else {
                seekVirtual(-0.1);
              }
              return;
            }
            break;
          case '6': // Numpad 6: 100ms forward (or Ctrl+Numpad6: 1 frame forward)
            if (e.location === 3) {
              e.preventDefault();
              if (e.ctrlKey) {
                seekVirtual(0.033);
              } else {
                seekVirtual(0.1);
              }
              return;
            }
            break;
          case '5': // Numpad 5: toggle play/pause
            if (e.location === 3) {
              e.preventDefault();
              togglePlay();
              return;
            }
            break;
          case '7': // Numpad 7: play active sub and stop
            if (e.location === 3) {
              e.preventDefault();
              playActiveSub();
              return;
            }
            break;
          case '8': // Numpad 8: insert new sub at playhead
            if (e.location === 3) {
              e.preventDefault();
              insertSubtitleAtPlayhead();
              return;
            }
            break;
          case '1': // Numpad 1: set active sub start
            if (e.location === 3) {
              e.preventDefault();
              setActiveSubStart();
              return;
            }
            break;
          case '2': // Numpad 2: set active sub end
            if (e.location === 3) {
              e.preventDefault();
              setActiveSubEnd();
              return;
            }
            break;
          case 'PageDown':
            e.preventDefault();
            goToNextSub();
            return;
          case 'PageUp':
            e.preventDefault();
            goToPrevSub();
            return;
          case 'Delete':
            e.preventDefault();
            deleteActiveSub();
            return;
        }
      }

      switch(e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'k':
          togglePlay();
          break;
        case 'delete':
        case 'backspace':
          if (!subtitleMode) {
            handleDelete();
          }
          break;
        case 'escape':
          setSelection(null);
          break;
        case 'arrowleft':
          e.preventDefault();
          if (e.shiftKey) {
            if (e.repeat) {
              selectionRepeatCount.current += 1;
            } else {
              selectionRepeatCount.current = 0;
            }
            const multiplier = Math.pow(1.5, Math.min(selectionRepeatCount.current / 3, 10));
            handleSelection(-1, multiplier);
          } else if (e.ctrlKey) {
            seekVirtual(-0.033);
          } else {
            seekBackward();
          }
          break;
        case 'arrowright':
          e.preventDefault();
          if (e.shiftKey) {
            if (e.repeat) {
              selectionRepeatCount.current += 1;
            } else {
              selectionRepeatCount.current = 0;
            }
            const multiplier = Math.pow(1.5, Math.min(selectionRepeatCount.current / 3, 10));
            handleSelection(1, multiplier);
          } else if (e.ctrlKey) {
            seekVirtual(0.033);
          } else {
            seekForward();
          }
          break;
        case 'arrowup':
          e.preventDefault();
          setZoomLevel(prev => Math.min(prev * 1.5, 200));
          break;
        case 'arrowdown':
          e.preventDefault();
          setZoomLevel(prev => Math.max(prev / 1.5, 1));
          break;
        case 'home':
          seekToStart();
          break;
        case 'end':
          e.preventDefault();
          const vDuration = getVirtualDuration();
          const { sourceTime } = getSourceFromVirtual(vDuration);
          if (videoRef.current) {
            videoRef.current.currentTime = sourceTime;
            setCurrentTime(vDuration);
          }
          break;
        case '1':
          setPlaybackRate(0.5);
          if (videoRef.current) videoRef.current.playbackRate = 0.5;
          break;
        case '2':
          setPlaybackRate(1);
          if (videoRef.current) videoRef.current.playbackRate = 1;
          break;
        case '3':
          setPlaybackRate(1.5);
          if (videoRef.current) videoRef.current.playbackRate = 1.5;
          break;
        case '4':
          setPlaybackRate(2);
          if (videoRef.current) videoRef.current.playbackRate = 2;
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        selectionRepeatCount.current = 0;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyPress);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isPlaying, currentTime, segments, selection, zoomLevel, canvasWidth, subtitleMode, subtitles]);

  // Close video and reset state
  const handleCloseVideo = () => {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }
    setVideoFile(null);
    setVideoUrl(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setSegments([]);
    setWaveformSamples([]);
    setSelection(null);
    setZoomLevel(1);
    setPlaybackRate(1);
    setError(null);
    setDebugInfo('');
    handleCloseSubtitles();
  };

  // Save edited video info
  const handleSave = () => {
    if (!videoFile) return;
    const editData = {
      originalFile: videoFile.name,
      segments: segments,
      duration: getVirtualDuration()
    };
    
    const dataStr = JSON.stringify(editData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    
    const lastDotIndex = videoFile.name.lastIndexOf('.');
    const nameWithoutExt = lastDotIndex !== -1 ? videoFile.name.substring(0, lastDotIndex) : videoFile.name;
    link.download = `${nameWithoutExt}_edits.json`;
    
    link.click();
    URL.revokeObjectURL(url);
  };

  // Load edit data from JSON file
  const handleLoadEdit = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!videoFile) {
      setError('Please load a video file first before loading edit data');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const result = event.target?.result;
        if (typeof result !== 'string') throw new Error('Failed to read file');
        const editData = JSON.parse(result);
        
        if (!editData.segments || !Array.isArray(editData.segments)) {
          throw new Error('Invalid edit file: missing segments');
        }
        
        if (editData.originalFile && editData.originalFile !== videoFile.name) {
          setDebugInfo(`Warning: Edit file was for "${editData.originalFile}", but current video is "${videoFile.name}"`);
        } else {
          setDebugInfo(`Edit data loaded successfully: ${editData.segments.length} segments`);
        }
        
        setSegments(editData.segments as Segment[]);
        setSelection(null);
        setCurrentTime(0);
        
        if (videoRef.current) {
          videoRef.current.currentTime = editData.segments[0]?.start || 0;
        }
        
      } catch (err: any) {
        setError('Failed to load edit file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  // Get active subtitle for display on video
  const activeSubIdx = getActiveSubtitleIndex();
  const activeSubForDisplay = activeSubIdx >= 0 ? subtitles[activeSubIdx] : null;
  const { sourceTime: currentSourceTime } = getSourceFromVirtualFn(currentTime, segments);
  const showActiveSub = activeSubForDisplay && currentSourceTime >= activeSubForDisplay.start && currentSourceTime <= activeSubForDisplay.end;

  return (
    <div className="h-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 p-4 border-b border-gray-700 flex items-center justify-between">
        <h1 className="text-xl font-bold">Sound-Based Video Editor</h1>
        <div className="flex gap-2">
          <label className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded cursor-pointer flex items-center gap-2">
            <Upload size={18} />
            Open Video
            <input type="file" accept="video/*" onChange={handleFileOpen} className="hidden" />
          </label>
          <button 
            onClick={handleCloseVideo}
            disabled={!videoFile}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50 rounded flex items-center gap-2"
          >
            <X size={18} />
            Close Video
          </button>
          <label className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded cursor-pointer flex items-center gap-2 disabled:bg-gray-600 disabled:cursor-not-allowed">
            <FolderOpen size={18} />
            Load Edits
            <input 
              type="file" 
              accept=".json,application/json" 
              onChange={handleLoadEdit} 
              className="hidden" 
              disabled={!videoFile}
            />
          </label>
          <button 
            onClick={handleSave}
            disabled={segments.length === 0}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded flex items-center gap-2"
          >
            <Save size={18} />
            Save Edits
          </button>

          {/* Subtitle buttons */}
          <div className="border-l border-gray-600 mx-1" />
          <label className={`px-4 py-2 rounded cursor-pointer flex items-center gap-2 ${subtitleMode ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-teal-600 hover:bg-teal-700'}`}>
            <Subtitles size={18} />
            {subtitleMode ? 'Subs Active' : 'Open Subs'}
            <input 
              type="file" 
              accept=".srt,.vtt" 
              onChange={handleSubtitleFileOpen} 
              className="hidden" 
            />
          </label>
          {subtitleMode && (
            <>
              <button 
                onClick={handleSubtitleSave}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded flex items-center gap-2"
                title="Save subtitle file (Ctrl+S)"
              >
                <Save size={18} />
                Save Subs
              </button>
              <button 
                onClick={handleSubtitleExport}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded flex items-center gap-2"
              >
                <Download size={18} />
                Export Subs
              </button>
              <button 
                onClick={handleCloseSubtitles}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded flex items-center gap-2"
              >
                <X size={18} />
                Close Subs
              </button>
            </>
          )}
        </div>
      </div>

      {/* Video Preview */}
      <div className="flex-1 flex items-center justify-center bg-black p-4 relative min-h-0 overflow-hidden">
        {videoUrl ? (
          <div className="w-full h-full flex flex-col items-center justify-center relative min-h-0 overflow-hidden">
            <video
              ref={videoRef}
              src={videoUrl}
              onLoadedMetadata={handleVideoLoaded}
              onTimeUpdate={handleTimeUpdate}
              onError={handleVideoError}
              className="max-w-full max-h-full object-contain flex-shrink"
              controls={false}
            />
            {/* Subtitle overlay on video */}
            {showActiveSub && activeSubForDisplay && (
              <div className="absolute bottom-16 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 text-white px-4 py-2 rounded text-lg text-center max-w-2xl whitespace-pre-wrap">
                {activeSubForDisplay.text}
              </div>
            )}
            {error && (
              <div className="mt-4 p-4 bg-red-900 text-red-200 rounded max-w-2xl">
                <strong>Error:</strong> {error}
              </div>
            )}
            {debugInfo && (
              <div className="mt-2 text-xs text-gray-400 max-w-2xl">
                {debugInfo}
              </div>
            )}
          </div>
        ) : (
          <div className="text-gray-500 text-center">
            <Upload size={48} className="mx-auto mb-2" />
            <p>Open a video file to begin editing</p>
            <p className="text-xs mt-2">Supported formats: MP4, WebM, OGG</p>
          </div>
        )}
      </div>

      {/* Waveform and Controls */}
      <div className="bg-gray-800 p-4 border-t border-gray-700">
        <div 
          ref={scrollContainerRef}
          className="mb-4 relative overflow-x-auto"
        >
          <canvas 
            ref={canvasRef}
            width={actualCanvasWidth}
            height={120}
            onClick={handleWaveformClick}
            onMouseDown={handleWaveformMouseDown}
            className="bg-gray-900 rounded cursor-pointer"
            style={{ cursor: dragState ? (dragState.type === 'resize-end' ? 'ew-resize' : 'grabbing') : 'pointer' }}
          />
          {isGeneratingWaveform && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-75 rounded">
              <span className="text-sm">Generating waveform...</span>
            </div>
          )}
        </div>

        {/* Subtitle text editor */}
        {subtitleMode && editingSubText !== null && (
          <div className="mb-4 flex items-start gap-2">
            <span className="text-sm text-yellow-400 mt-1 whitespace-nowrap">Sub #{activeSubIdx + 1}:</span>
            <textarea
              ref={subTextInputRef}
              value={editingSubText}
              onChange={(e) => handleSubTextChange(e.target.value)}
              className="flex-1 bg-gray-900 text-white border border-gray-600 rounded px-3 py-2 text-sm resize-none"
              rows={2}
              placeholder="Subtitle text..."
            />
          </div>
        )}

        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <button 
              onClick={togglePlay} 
              disabled={!videoUrl}
              className="p-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded"
            >
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <span className="text-sm font-mono">{formatTime(currentTime)} / {formatTime(getVirtualDuration())}</span>
            <span className="text-sm text-gray-400">Speed: {playbackRate}x</span>
            {subtitleMode && (
              <span className="text-sm text-yellow-400 bg-yellow-900 bg-opacity-30 px-2 py-1 rounded">
                SUB MODE
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {!subtitleMode && (
              <button 
                onClick={handleDelete} 
                disabled={!selection}
                className="px-3 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded flex items-center gap-2"
              >
                <Trash2 size={18} />
                Delete Selection (Del)
              </button>
            )}
            <span className="text-sm text-gray-400 ml-2">{segments.length} segment{segments.length !== 1 ? 's' : ''}</span>
            {subtitleMode && (
              <span className="text-sm text-gray-400 ml-2">| {subtitles.length} sub{subtitles.length !== 1 ? 's' : ''}</span>
            )}
          </div>
        </div>

        {/* Keyboard Shortcuts Help */}
        <div className="text-xs text-gray-400 bg-gray-900 p-3 rounded">
          <strong>Keyboard Shortcuts:</strong> Space/K: Play/Pause | Shift+←/→: Select | Esc: Clear selection | Del: Delete Selection | ←/→: Seek | Ctrl+←/→: Frame step | ↑/↓: Zoom | Home/End: Jump to Start/End | 1/2/3/4: Speed | Click waveform to seek
          {subtitleMode && (
            <>
              <br />
              <strong className="text-yellow-400">Subtitle Mode:</strong> Num4/6: ±100ms | Ctrl+Num4/6: ±1 frame | Num5: Play/Pause | Num7: Play active sub | Num8: Insert sub | Num1/2: Set sub start/end | PgUp/PgDn: Prev/Next sub | Del: Delete sub | Ctrl+S: Save subs
            </>
          )}
        </div>
      </div>
    </div>
  );
}
