import axios from 'axios';

// Use environment variables for sensitive data - check lazily inside functions
// MODEL_ID format from Roboflow: workspace/project/version
const MODEL_ID = "chess-cfal9/4";
const VERSION = "4";

// Type definitions
export interface ChessPieceDetection {
  x: number;
  y: number;
  width: number;
  height: number;
  class: string; // e.g., "white-pawn", "black-king"
  confidence: number;
}

interface RoboflowResponse {
  predictions: ChessPieceDetection[];
}

interface GridSquare {
  row: number;
  col: number;
  piece: string | null;
  confidence: number;
}

// Map piece class names to FEN notation
// Roboflow returns class names like "w-pawn", "b-queen", etc.
const pieceClassToFEN: Record<string, string> = {
  // Full format (white-pawn, black-queen, etc.)
  'white-pawn': 'P',
  'white-rook': 'R',
  'white-knight': 'N',
  'white-bishop': 'B',
  'white-queen': 'Q',
  'white-king': 'K',
  'black-pawn': 'p',
  'black-rook': 'r',
  'black-knight': 'n',
  'black-bishop': 'b',
  'black-queen': 'q',
  'black-king': 'k',
  // Short format (w-pawn, b-queen, etc.) - Roboflow format
  'w-pawn': 'P',
  'w-rook': 'R',
  'w-knight': 'N',
  'w-bishop': 'B',
  'w-queen': 'Q',
  'w-king': 'K',
  'b-pawn': 'p',
  'b-rook': 'r',
  'b-knight': 'n',
  'b-bishop': 'b',
  'b-queen': 'q',
  'b-king': 'k',
};

export const detectChessPieces = async (base64Image: string): Promise<ChessPieceDetection[]> => {
  try {
    // Check API key lazily (only when function is called, not at module load)
    const ROBOFLOW_API_KEY = import.meta.env?.VITE_ROBOFLOW_API_KEY as string | undefined;
    if (!ROBOFLOW_API_KEY) {
      // In production, use generic error message to avoid information disclosure
      const errorMessage = import.meta.env.DEV
        ? 'VITE_ROBOFLOW_API_KEY environment variable is required. Please set it in your .env file.'
        : 'API configuration error. Please contact the administrator.';
      throw new Error(errorMessage);
    }
    
    // Roboflow expects base64 data without the data URL prefix
    // Remove "data:image/jpeg;base64," or similar prefix if present
    const base64Data = base64Image.includes(',') 
      ? base64Image.split(',')[1] 
      : base64Image;

    // Validate and decode base64 safely
    let byteCharacters: string;
    try {
      byteCharacters = atob(base64Data);
    } catch (error) {
      throw new Error('Invalid base64 image data');
    }

    // Roboflow API: Convert base64 to blob and send as multipart/form-data file
    // The endpoint is correct (400 means it exists, just wrong format)
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'image/png' });
    
    // Enforce HTTPS for API calls
    const API_URL = `https://detect.roboflow.com/${MODEL_ID}`;
    if (!API_URL.startsWith('https://')) {
      throw new Error('API calls must use HTTPS');
    }
    
    const formData = new FormData();
    formData.append('file', blob, 'image.png');

    // Note: Roboflow API requires api_key in query params
    // Using axios params ensures proper URL encoding
    const response = await axios.post<RoboflowResponse>(
      API_URL,
      formData,
      {
        params: {
          api_key: ROBOFLOW_API_KEY,
        },
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      }
    );
    
    // Validate response data structure
    const validateDetection = (det: any): det is ChessPieceDetection => {
      return (
        typeof det === 'object' &&
        det !== null &&
        typeof det.x === 'number' &&
        typeof det.y === 'number' &&
        typeof det.width === 'number' &&
        typeof det.height === 'number' &&
        typeof det.class === 'string' &&
        typeof det.confidence === 'number' &&
        !isNaN(det.x) && !isNaN(det.y) &&
        det.x >= 0 && det.y >= 0 &&
        det.width >= 0 && det.height >= 0 &&
        det.confidence >= 0 && det.confidence <= 1
      );
    };
    
    // Check if response.data is the predictions array directly, or if it has a predictions property
    let rawPredictions: any[] = [];
    if (Array.isArray(response.data)) {
      // Response is directly an array of predictions
      rawPredictions = response.data;
    } else if (response.data?.predictions && Array.isArray(response.data.predictions)) {
      // Response has a predictions property
      rawPredictions = response.data.predictions;
    }
    
    // Validate and filter predictions
    const predictions: ChessPieceDetection[] = rawPredictions.filter(validateDetection);
    
    return predictions; 
  } catch (error) {
    // Only log detailed errors in development
    if (import.meta.env.DEV) {
      console.error("Detection Error:", error);
      if (axios.isAxiosError(error)) {
        console.error("Response:", error.response?.data);
      }
    } else {
      // In production, log minimal info
      console.error("Failed to detect chess pieces");
    }
    return [];
  }
};

/**
 * Maps chess piece detections to an 8x8 grid and converts to FEN string
 * @param detections Array of piece detections from Roboflow
 * @param imageWidth Width of the image (optional, for better grid mapping)
 * @param imageHeight Height of the image (optional, for better grid mapping)
 * @returns FEN string representing the board position
 */
export const detectionsToFEN = (
  detections: ChessPieceDetection[],
  imageWidth?: number,
  imageHeight?: number
): string => {
  // Initialize 8x8 grid
  const grid: GridSquare[][] = Array(8)
    .fill(null)
    .map(() =>
      Array(8)
        .fill(null)
        .map(() => ({ row: 0, col: 0, piece: null, confidence: 0 }))
    );

  // If we have image dimensions, use them; otherwise estimate from detections
  let boardWidth = imageWidth || 0;
  let boardHeight = imageHeight || 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  if (!imageWidth || !imageHeight) {
    // Estimate board boundaries from detection positions
    detections.forEach((det) => {
      const centerX = det.x;
      const centerY = det.y;
      const halfWidth = det.width / 2;
      const halfHeight = det.height / 2;

      minX = Math.min(minX, centerX - halfWidth);
      minY = Math.min(minY, centerY - halfHeight);
      maxX = Math.max(maxX, centerX + halfWidth);
      maxY = Math.max(maxY, centerY + halfHeight);
    });

    boardWidth = maxX - minX;
    boardHeight = maxY - minY;
  } else {
    // Assume board takes up most of the image (with some margin)
    // Use smaller margin to better fit the board
    const margin = 0.05; // 5% margin (reduced from 10%)
    minX = imageWidth * margin;
    minY = imageHeight * margin;
    boardWidth = imageWidth * (1 - 2 * margin);
    boardHeight = imageHeight * (1 - 2 * margin);
  }

  // Validate board dimensions before division to prevent division by zero
  if (boardWidth <= 0 || boardHeight <= 0) {
    // Return empty board FEN if dimensions are invalid
    return '8/8/8/8/8/8/8/8 w - - 0 1';
  }

  // Calculate square size
  const squareWidth = boardWidth / 8;
  const squareHeight = boardHeight / 8;
  
  // Additional validation to ensure square size is valid
  if (squareWidth <= 0 || squareHeight <= 0 || !isFinite(squareWidth) || !isFinite(squareHeight)) {
    // Return empty board FEN if square size is invalid
    return '8/8/8/8/8/8/8/8 w - - 0 1';
  }

  // Map each detection to a grid square
  detections.forEach((det, index) => {
    const centerX = det.x;
    const centerY = det.y;

    // Calculate which square this detection belongs to
    // Roboflow coordinates: x increases left-to-right, y increases top-to-bottom
    // FEN notation: row 0 is top (rank 8), row 7 is bottom (rank 1)
    // Column: a=0, b=1, ..., h=7 (left to right)
    const col = Math.floor((centerX - minX) / squareWidth);
    const row = Math.floor((centerY - minY) / squareHeight); // Row 0 is top of image (rank 8 in FEN)

    // Clamp values to valid range
    const clampedRow = Math.max(0, Math.min(7, row));
    const clampedCol = Math.max(0, Math.min(7, col));

    // Get FEN piece mapping (supports both "w-pawn" and "white-pawn" formats)
      const fenPiece = pieceClassToFEN[det.class.toLowerCase()];

      if (fenPiece) {
        // If square already has a piece, keep the one with higher confidence
      if (!grid[clampedRow][clampedCol].piece || det.confidence > grid[clampedRow][clampedCol].confidence) {
        grid[clampedRow][clampedCol].piece = fenPiece;
        grid[clampedRow][clampedCol].confidence = det.confidence;
        grid[clampedRow][clampedCol].row = clampedRow;
        grid[clampedRow][clampedCol].col = clampedCol;
      }
    }
  });

  // Convert grid to FEN notation
  let fenBoard = '';
  for (let row = 0; row < 8; row++) {
    let emptyCount = 0;
    for (let col = 0; col < 8; col++) {
      const square = grid[row][col];
      if (square.piece) {
        if (emptyCount > 0) {
          fenBoard += emptyCount;
          emptyCount = 0;
        }
        fenBoard += square.piece;
      } else {
        emptyCount++;
      }
    }
    if (emptyCount > 0) {
      fenBoard += emptyCount;
    }
    if (row < 7) {
      fenBoard += '/';
    }
  }

  // Return FEN with default values for other fields
  // Format: "board turn castling enpassant halfmove fullmove"
  return `${fenBoard} w - - 0 1`;
};

/**
 * Processes an image file and returns a FEN string
 * @param imageFile The image file to process
 * @returns Promise resolving to FEN string
 */
// Constants for file validation
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

// Validate image file by checking magic bytes (file signature)
const validateImageFileContent = (file: File): Promise<boolean> => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const bytes = new Uint8Array(e.target?.result as ArrayBuffer);
      // Check magic bytes for image formats
      const isValid = 
        // JPEG: FF D8 FF
        (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) ||
        // PNG: 89 50 4E 47
        (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) ||
        // GIF: 47 49 46 38 (GIF8)
        (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) ||
        // WebP: RIFF header (52 49 46 46) followed by WEBP
        (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && 
         bytes.length >= 12 && 
         String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP');
      resolve(isValid);
    };
    reader.onerror = () => resolve(false);
    // Read first 12 bytes to check magic numbers
    reader.readAsArrayBuffer(file.slice(0, 12));
  });
};

export const processImageToFEN = async (imageFile: File): Promise<string> => {
  // Validate file size
  if (imageFile.size > MAX_FILE_SIZE) {
    throw new Error(`File size must be less than ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
  }

  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.includes(imageFile.type.toLowerCase())) {
    throw new Error('Invalid file type. Please upload a JPEG, PNG, GIF, or WebP image.');
  }

  // Validate actual file content (magic bytes) to prevent MIME type spoofing
  const isValidContent = await validateImageFileContent(imageFile);
  if (!isValidContent) {
    throw new Error('Invalid image file. File content does not match declared type.');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const base64Image = e.target?.result as string;
        const img = new Image();
        
        img.onload = async () => {
          try {
            // Validate image dimensions to prevent memory exhaustion
            const MAX_DIMENSION = 5000; // pixels
            if (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) {
              reject(new Error(`Image dimensions must be less than ${MAX_DIMENSION}x${MAX_DIMENSION} pixels`));
              return;
            }
            
            // Validate minimum dimensions
            const MIN_DIMENSION = 50; // pixels
            if (img.width < MIN_DIMENSION || img.height < MIN_DIMENSION) {
              reject(new Error(`Image dimensions must be at least ${MIN_DIMENSION}x${MIN_DIMENSION} pixels`));
              return;
            }
            
            // Get detections from Roboflow
            const detections = await detectChessPieces(base64Image);
            
            if (detections.length === 0) {
              reject(new Error('No pieces detected in image'));
              return;
            }

            // Convert detections to FEN
            const fen = detectionsToFEN(detections, img.width, img.height);
            resolve(fen);
          } catch (error) {
            reject(error);
          }
        };

        img.onerror = () => {
          reject(new Error('Failed to load image'));
        };

        img.src = base64Image;
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read image file'));
    };

    reader.readAsDataURL(imageFile);
  });
};