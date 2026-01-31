import React, { useState, useRef, useEffect } from 'react';
import { Upload, Save, Play, Pause, Trash2, FolderOpen } from 'lucide-react';

export default function VideoEditor() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0); // Virtual time
  const [totalDuration, setTotalDuration] = useState(0); // Sum of all segments
  
  // Editor state
  interface Segment {
    start: number;
    end: number;
  }
  const [segments, setSegments] = useState<Segment[]>([]); // Array of { start, end } (source times)
  const [waveformSamples, setWaveformSamples] = useState<number[]>([]); // High-res samples
  interface Selection {
    start: number;
    end: number;
    anchor: number;
    head?: number;
  }
  const [selection, setSelection] = useState<Selection | null>(null); // { start, end, anchor, head } (virtual times)
  const [zoomLevel, setZoomLevel] = useState(1);
  
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isGeneratingWaveform, setIsGeneratingWaveform] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState('');
  const [canvasWidth, setCanvasWidth] = useState(window.innerWidth);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
    console.log('Video loaded! Duration:', video.duration, 'Ready state:', video.readyState);
    setDebugInfo(prev => prev + ' | Video loaded successfully');
    setTotalDuration(video.duration);
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
      
      const channelData = audioBuffer.getChannelData(0); // Get first channel
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
        
        // RMS
        samples.push(Math.sqrt(sum / (end - start)));
      }

      console.log('Samples generated:', samples.length);

      // Normalize the data
      const max = Math.max(...samples);
      const normalized = samples.map(s => max > 0 ? s / max : 0);
      
      setWaveformSamples(normalized);
      setDebugInfo(prev => prev + ' | Waveform generated via AudioBuffer');
      
    } catch (error) {
      console.error('Error generating waveform:', error);
      setError('Waveform generation failed: ' + error.message);
      setWaveformSamples([]);
    }
    
    setIsGeneratingWaveform(false);
  };

  // Helper to get total duration from segments
  const getVirtualDuration = () => {
    return segments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);
  };

  // Draw waveform
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    if (waveformSamples.length === 0 || segments.length === 0) {
      // Draw placeholder
      ctx.fillStyle = '#4b5563';
      ctx.fillRect(0, height / 2 - 2, width, 4);
      return;
    }

    const virtualDuration = getVirtualDuration();
    if (virtualDuration === 0) return;

    const samplesPerSec = 50; // Must match generateWaveform
    let currentX = 0;

    // Draw segments
    segments.forEach(seg => {
      const segDuration = seg.end - seg.start;
      const segWidth = (segDuration / virtualDuration) * width;
      
      // Calculate which samples to draw
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
      
      // Draw segment separator
      if (currentX > 0) {
        ctx.fillStyle = '#1f2937'; // dark gray separator
        ctx.fillRect(currentX, 0, 2, height);
      }

      currentX += segWidth;
    });

    // Draw selection
    if (selection) {
      const startX = (selection.start / virtualDuration) * width;
      const endX = (selection.end / virtualDuration) * width;
      
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)'; // Red transparent
      ctx.fillRect(startX, 0, endX - startX, height);
      
      // Selection borders
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

  }, [waveformSamples, currentTime, segments, selection, zoomLevel]);

  // Convert virtual time to source time and segment index
  const getSourceFromVirtual = (vTime) => {
    let accumulated = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDuration = seg.end - seg.start;
      if (vTime >= accumulated && vTime <= accumulated + segDuration + 0.001) { // tolerance
        return { 
          sourceTime: seg.start + (vTime - accumulated),
          segmentIndex: i 
        };
      }
      accumulated += segDuration;
    }
    // Default to end of last segment
    if (segments.length > 0) {
      return { sourceTime: segments[segments.length - 1].end, segmentIndex: segments.length - 1 };
    }
    return { sourceTime: 0, segmentIndex: -1 };
  };

  // Update current time
  const handleTimeUpdate = () => {
    if (!videoRef.current || segments.length === 0) return;
    
    const videoTime = videoRef.current.currentTime;
    
    // Find active segment
    let virtualTimeAccumulator = 0;
    let activeSegmentIndex = -1;
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      // Check if inside segment (with slight fuzzy matching)
      if (videoTime >= seg.start - 0.1 && videoTime <= seg.end + 0.1) {
        activeSegmentIndex = i;
        // Clamp vTime to segment bounds
        const offset = Math.max(0, Math.min(seg.end - seg.start, videoTime - seg.start));
        setCurrentTime(virtualTimeAccumulator + offset);
        break;
      }
      virtualTimeAccumulator += (seg.end - seg.start);
    }
    
    // Gap skipping logic
    if (activeSegmentIndex === -1) {
      // We are lost (in a deleted gap), find next segment
      const nextSeg = segments.find(s => s.start > videoTime + 0.1);
      if (nextSeg) {
        videoRef.current.currentTime = nextSeg.start;
      } else {
        // End of all content
        if (isPlaying) {
          setIsPlaying(false);
          videoRef.current.pause();
        }
      }
    } else {
      // Check if we hit end of segment
      const seg = segments[activeSegmentIndex];
      if (videoTime >= seg.end - 0.05) { // 50ms before end
        if (activeSegmentIndex < segments.length - 1) {
          // Jump to next segment
          const nextSeg = segments[activeSegmentIndex + 1];
          videoRef.current.currentTime = nextSeg.start;
        } else {
          // End of video
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
  const seekVirtual = (delta) => {
    const vDuration = getVirtualDuration();
    const newVirtual = Math.max(0, Math.min(vDuration, currentTime + delta));
    
    const { sourceTime } = getSourceFromVirtual(newVirtual);
    
    if (videoRef.current) {
      videoRef.current.currentTime = sourceTime;
      setCurrentTime(newVirtual);
    }
  };

  const seekBackward = () => seekVirtual(-0.4);
  const seekForward = () => seekVirtual(0.4);
  const seekToStart = () => seekVirtual(-currentTime);

  // Click on waveform to seek
  const handleWaveformClick = (e) => {
    if (!canvasRef.current || segments.length === 0) return;
    
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
  
  // Selection handling
  const handleSelection = (direction) => { // 1 for right, -1 for left
    const step = 0.1; // Selection granularity
    
    if (!selection) {
      // Start new selection from current time
      const start = currentTime;
      const end = Math.max(0, Math.min(getVirtualDuration(), currentTime + (direction * step)));
      setSelection({ start: Math.min(start, end), end: Math.max(start, end), anchor: start });
    } else {
      // Modify existing selection
      const anchor = selection.anchor !== undefined ? selection.anchor : selection.start;
      // Current active edge is the one not matching anchor (or end if equal)
      // Actually simpler: just calculate new 'active' point
      // But we need to store 'active' point separate from start/end to allow flipping
      
      // Let's use a simplified model: assume we are extending the 'end' or 'start' based on where we are?
      // No, best is to track 'anchor' and 'head'.
      // I'll augment the selection object in state to include 'anchor'.
      
      let head = (selection.head !== undefined) ? selection.head : (direction > 0 ? selection.end : selection.start);
      // If we just started, head matches the moved end
      
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
    
    // We need to remove the range [selection.start, selection.end] (Virtual Time)
    // This involves splitting segments.
    
    const vStart = selection.start;
    const vEnd = selection.end;
    
    const newSegments = [];
    let accumulated = 0;
    
    segments.forEach(seg => {
      const segStartV = accumulated;
      const segEndV = accumulated + (seg.end - seg.start);
      
      // Check overlap
      if (segEndV <= vStart || segStartV >= vEnd) {
        // No overlap, keep segment
        newSegments.push(seg);
      } else {
        // Overlap exists
        // 1. Part before selection?
        if (segStartV < vStart) {
          newSegments.push({
            start: seg.start,
            end: seg.start + (vStart - segStartV)
          });
        }
        // 2. Part after selection?
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
    
    // Move playhead to start of cut
    const { sourceTime } = getSourceFromVirtual(vStart); // Note: segments changed, but this calc uses OLD segments? 
    // Wait, getSourceFromVirtual uses state 'segments'. If I use it after setSegments, it might be stale in closure?
    // Actually, I can just recalculate playhead position.
    // Ideally, playhead stays at vStart.
    // But vStart in the NEW timeline is different?
    // No, vStart is the cut point. In the new timeline, everything after vEnd shifts left by (vEnd-vStart).
    // So the new time should be vStart.
    
    // We need to set video currentTime to the new source time corresponding to vStart.
    // But we need to use the NEW segments to find that source time.
    // I'll do it manually here with 'newSegments'.
    
    // Find source time for vStart in newSegments
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
    
    const waveformWidth = canvasWidth * zoomLevel;
    const playheadX = (currentTime / vDuration) * waveformWidth;
    
    const scrollLeft = container.scrollLeft;
    const clientWidth = container.clientWidth;
    
    // If playhead is out of view
    if (playheadX < scrollLeft || playheadX > scrollLeft + clientWidth) {
      container.scrollLeft = playheadX - (clientWidth / 2);
    }
  }, [currentTime, zoomLevel, segments, canvasWidth]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.target.tagName === 'INPUT') return;

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
          handleDelete();
          break;
        case 'arrowleft':
          e.preventDefault();
          if (e.shiftKey) {
            handleSelection(-1);
          } else {
            seekBackward();
          }
          break;
        case 'arrowright':
          e.preventDefault();
          if (e.shiftKey) {
            handleSelection(1);
          } else {
            seekForward();
          }
          break;
        case 'arrowup':
          e.preventDefault();
          setZoomLevel(prev => Math.min(prev * 1.5, 20)); // Increased zoom steps
          break;
        case 'arrowdown':
          e.preventDefault();
          setZoomLevel(prev => Math.max(prev / 1.5, 1));
          break;
        case 'h':
          seekToStart();
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

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isPlaying, currentTime, totalDuration, segments, selection, zoomLevel, canvasWidth]);

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
    
    // Create filename based on original video file
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
        
        // Validate the loaded data
        if (!editData.segments || !Array.isArray(editData.segments)) {
          throw new Error('Invalid edit file: missing segments');
        }
        
        // Check if the original file name matches (optional warning)
        if (editData.originalFile && editData.originalFile !== videoFile.name) {
          setDebugInfo(`Warning: Edit file was for "${editData.originalFile}", but current video is "${videoFile.name}"`);
        } else {
          setDebugInfo(`Edit data loaded successfully: ${editData.segments.length} segments`);
        }
        
        // Restore segments
        setSegments(editData.segments as Segment[]);
        setSelection(null);
        setCurrentTime(0);
        
        // Reset video to start
        if (videoRef.current) {
          videoRef.current.currentTime = editData.segments[0]?.start || 0;
        }
        
      } catch (err: any) {
        setError('Failed to load edit file: ' + err.message);
      }
    };
    reader.readAsText(file);
    
    // Reset the input so the same file can be selected again
    e.target.value = '';
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

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
        </div>
      </div>

      {/* Video Preview */}
      <div className="flex-1 flex items-center justify-center bg-black p-4">
        {videoUrl ? (
          <div className="w-full h-full flex flex-col items-center justify-center">
            <video
              ref={videoRef}
              src={videoUrl}
              onLoadedMetadata={handleVideoLoaded}
              onTimeUpdate={handleTimeUpdate}
              onError={handleVideoError}
              className="max-w-full max-h-full"
              controls={false}
            />
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
            width={canvasWidth * zoomLevel}
            height={120}
            onClick={handleWaveformClick}
            className="bg-gray-900 rounded cursor-pointer"
          />
          {isGeneratingWaveform && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-75 rounded">
              <span className="text-sm">Generating waveform...</span>
            </div>
          )}
        </div>

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
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={handleDelete} 
              disabled={!selection}
              className="px-3 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded flex items-center gap-2"
            >
              <Trash2 size={18} />
              Delete Selection (Del)
            </button>
            <span className="text-sm text-gray-400 ml-2">{segments.length} segment{segments.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Keyboard Shortcuts Help */}
        <div className="text-xs text-gray-400 bg-gray-900 p-3 rounded">
          <strong>Keyboard Shortcuts:</strong> Space/K: Play/Pause | Shift+←/→: Select | Del: Delete Selection | ←/→: Seek | ↑/↓: Zoom | H: Jump to Start | 1/2/3/4: Speed | Click waveform to seek
        </div>
      </div>
    </div>
  );
}