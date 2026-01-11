import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { processImageToFEN } from './visionService'

// Constants moved outside component to avoid recreation on every render
const DEFAULT_FEN_PARTS = ['', 'w', '-', '-', '0', '1']

const PIECE_SYMBOLS = {
  'w': {
    'p': '♙', 'r': '♖', 'n': '♘', 'b': '♗', 'q': '♕', 'k': '♔'
  },
  'b': {
    'p': '♟', 'r': '♜', 'n': '♞', 'b': '♝', 'q': '♛', 'k': '♚'
  }
}

// Map piece type names to FEN characters
const pieceTypeToFEN = {
  'pawn': 'p',
  'rook': 'r',
  'knight': 'n',
  'bishop': 'b',
  'queen': 'q',
  'king': 'k'
}

// Reverse map: FEN characters to piece type names
const fenToPieceType = {
  'p': 'pawn',
  'r': 'rook',
  'n': 'knight',
  'b': 'bishop',
  'q': 'queen',
  'k': 'king'
}

const PIECE_TYPES = ['p', 'n', 'b', 'r', 'q', 'k']
const PIECE_COLORS = ['w', 'b']

function App() {
  const [game, setGame] = useState(new Chess())
  const [fen, setFen] = useState(game.fen())
  const [isBoardFlipped, setIsBoardFlipped] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingError, setProcessingError] = useState(null)
  const [draggedPiece, setDraggedPiece] = useState(null)
  const fileInputRef = useRef(null)
  const paletteRef = useRef(null)
  const dragImageTimeoutRef = useRef(null)
  
  // Rate limiting: track last API call time
  const lastApiCallRef = useRef(0)
  const API_CALL_COOLDOWN = 1000 // 1 second between API calls
  
  // Pre-create transparent drag image to prevent default dashed rectangle
  // Use a canvas with alpha channel for true transparency
  const transparentDragImageRef = useRef(null)
  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d', { alpha: true })
    // Create a fully transparent pixel
    ctx.fillStyle = 'rgba(0, 0, 0, 0)'
    ctx.fillRect(0, 0, 1, 1)
    // Keep in DOM but hidden, always ready
    canvas.style.position = 'absolute'
    canvas.style.top = '-1000px'
    canvas.style.left = '-1000px'
    canvas.style.width = '1px'
    canvas.style.height = '1px'
    canvas.style.pointerEvents = 'none'
    canvas.style.opacity = '0'
    document.body.appendChild(canvas)
    transparentDragImageRef.current = canvas
    
    // Cleanup function to prevent memory leak
    return () => {
      // Clear any pending timeouts
      if (dragImageTimeoutRef.current) {
        clearTimeout(dragImageTimeoutRef.current)
      }
      if (transparentDragImageRef.current && document.body.contains(transparentDragImageRef.current)) {
        document.body.removeChild(transparentDragImageRef.current)
      }
    }
  }, [])

  const onDrop = (sourceSquare, targetSquare) => {
    // Validate square notation format
    if (!sourceSquare || sourceSquare.length !== 2 || !targetSquare || targetSquare.length !== 2) {
      return false
    }
    
    // Validate square characters
    const sourceFile = sourceSquare[0]
    const sourceRank = sourceSquare[1]
    const targetFile = targetSquare[0]
    const targetRank = targetSquare[1]
    
    if (sourceFile < 'a' || sourceFile > 'h' || sourceRank < '1' || sourceRank > '8' ||
        targetFile < 'a' || targetFile > 'h' || targetRank < '1' || targetRank > '8') {
      return false
    }

    // Don't make valid moves that change the turn - always do free editing
    // Turn should only change when user clicks "Switch" button

    // For free editing: parse FEN directly to preserve all pieces
    if (!fen || typeof fen !== 'string') {
      return false
    }
    
    const fenParts = fen.split(' ')
    if (fenParts.length < 6 || !fenParts[0]) {
      return false
    }
    
    const boardPart = fenParts[0]
    const ranks = boardPart.split('/')
    
    if (ranks.length !== 8) {
      return false
    }
    
    // Convert ranks to 2D array
    const board = Array(8).fill(null).map(() => Array(8).fill(null))
    for (let i = 0; i < 8; i++) {
      if (!ranks[i]) {
        continue // Skip missing rank
      }
      let col = 0
      for (let j = 0; j < ranks[i].length && col < 8; j++) {
        const char = ranks[i][j]
        if (char >= '1' && char <= '8') {
          const num = parseInt(char, 10)
          col += num
          // Clamp column to valid range
          if (col > 8) col = 8
        } else {
          // Clamp column to valid range before accessing board
          if (col >= 0 && col < 8) {
            const isWhite = char >= 'A' && char <= 'Z'
            const pieceType = char.toLowerCase()
            if (fenToPieceType[pieceType]) {
              board[i][col] = { type: fenToPieceType[pieceType], color: isWhite ? 'w' : 'b' }
            }
          }
          col++
          if (col > 8) break // Prevent overflow
        }
      }
    }

    // Get piece from source with bounds validation
    const sourceRow = 8 - parseInt(sourceRank, 10)
    const sourceCol = sourceFile.charCodeAt(0) - 97
    
    if (isNaN(sourceRow) || isNaN(sourceCol) || sourceRow < 0 || sourceRow > 7 || sourceCol < 0 || sourceCol > 7) {
      return false
    }
    
    const piece = board[sourceRow][sourceCol]
    if (!piece) return false

    const targetRow = 8 - parseInt(targetRank, 10)
    const targetCol = targetFile.charCodeAt(0) - 97
    
    if (isNaN(targetRow) || isNaN(targetCol) || targetRow < 0 || targetRow > 7 || targetCol < 0 || targetCol > 7) {
      return false
    }

    // Remove piece from source
    board[sourceRow][sourceCol] = null
    // Place piece on target (overwrites any existing piece)
    board[targetRow][targetCol] = piece

    // Convert board back to FEN
    let fenBoard = ''
    for (let i = 0; i < 8; i++) {
      let emptyCount = 0
      for (let j = 0; j < 8; j++) {
        const square = board[i][j]
        if (square === null) {
          emptyCount++
        } else {
          if (emptyCount > 0) {
            fenBoard += emptyCount
            emptyCount = 0
          }
          const pieceChar = pieceTypeToFEN[square.type] || 'p'
          fenBoard += square.color === 'w' ? pieceChar.toUpperCase() : pieceChar
        }
      }
      if (emptyCount > 0) {
        fenBoard += emptyCount
      }
      if (i < 7) fenBoard += '/'
    }

    // Preserve other FEN parts with defaults if missing
    // Preserve turn from current fen state to keep it independent
    const preservedTurn = fenParts[1] || DEFAULT_FEN_PARTS[1]
    const newFen = `${fenBoard} ${preservedTurn} ${fenParts[2] || DEFAULT_FEN_PARTS[2]} ${fenParts[3] || DEFAULT_FEN_PARTS[3]} ${fenParts[4] || DEFAULT_FEN_PARTS[4]} ${fenParts[5] || DEFAULT_FEN_PARTS[5]}`

    // Always update FEN (react-chessboard can display any FEN)
    setFen(newFen)
    
    // Try to update game instance, but preserve turn if validation changes it
    try {
      const newGame = new Chess(newFen)
      const gameFen = newGame.fen().split(' ')
      if (gameFen[1] !== preservedTurn) {
        gameFen[1] = preservedTurn
        const correctedFen = gameFen.join(' ')
        try {
          const correctedGame = new Chess(correctedFen)
          setGame(correctedGame)
          setFen(correctedFen)
        } catch {
          setGame(newGame)
        }
      } else {
        setGame(newGame)
      }
    } catch (error) {
      // Keep old game instance if FEN is invalid (e.g., multiple kings)
      // The FEN is already set for display with preserved turn
    }
    
    return true
  }

  const handleScanBoard = useCallback(() => {
    // Trigger file input click
    fileInputRef.current?.click()
  }, [])

  const handleImageUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    // Rate limiting: prevent too frequent API calls
    const now = Date.now()
    const timeSinceLastCall = now - lastApiCallRef.current
    if (timeSinceLastCall < API_CALL_COOLDOWN) {
      const waitTime = Math.ceil((API_CALL_COOLDOWN - timeSinceLastCall) / 1000)
      setProcessingError(`Please wait ${waitTime} second${waitTime > 1 ? 's' : ''} before uploading another image.`)
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      return
    }

    setIsProcessing(true)
    setProcessingError(null)
    lastApiCallRef.current = now

    try {
      const fen = await processImageToFEN(file)
      
      // Update board with detected position
      try {
        const newGame = new Chess(fen)
        setGame(newGame)
        setFen(newGame.fen())
      } catch (error) {
        // If FEN is invalid, try to fix it or show error
        if (import.meta.env.DEV) {
          console.error('Invalid FEN generated:', fen)
        }
        setProcessingError('Detected position may be invalid. Please verify the board.')
      }
    } catch (error) {
      // Only log detailed errors in development
      if (import.meta.env.DEV) {
        console.error('Error processing image:', error)
      }
      setProcessingError(
        error instanceof Error 
          ? error.message 
          : 'Failed to process image. Please try again.'
      )
    } finally {
      setIsProcessing(false)
      // Reset file input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleReset = useCallback(() => {
    const newGame = new Chess()
    setGame(newGame)
    setFen(newGame.fen())
  }, [])

  const handleClear = useCallback(() => {
    const emptyGame = new Chess()
    emptyGame.clear()
    setGame(emptyGame)
    setFen(emptyGame.fen())
  }, [])

  const handleSquareRightClick = (square) => {
    // Validate square notation format
    if (!square || square.length !== 2) {
      return
    }
    
    // Validate square characters
    const squareFile = square[0]
    const squareRank = square[1]
    
    if (squareFile < 'a' || squareFile > 'h' || squareRank < '1' || squareRank > '8') {
      return
    }
    
    // Parse FEN directly to avoid Chess.js validation issues
    if (!fen || typeof fen !== 'string') {
      return
    }
    
    const fenParts = fen.split(' ')
    if (fenParts.length < 6 || !fenParts[0]) {
      return
    }
    
    const boardPart = fenParts[0]
    const ranks = boardPart.split('/')
    
    if (ranks.length !== 8) {
      return
    }
    
    // Convert ranks to 2D array
    const board = Array(8).fill(null).map(() => Array(8).fill(null))
    for (let i = 0; i < 8; i++) {
      if (!ranks[i]) {
        continue // Skip missing rank
      }
      let col = 0
      for (let j = 0; j < ranks[i].length && col < 8; j++) {
        const char = ranks[i][j]
        if (char >= '1' && char <= '8') {
          const num = parseInt(char, 10)
          col += num
          if (col > 8) col = 8
        } else {
          if (col >= 0 && col < 8) {
            const isWhite = char >= 'A' && char <= 'Z'
            const pieceType = char.toLowerCase()
            if (fenToPieceType[pieceType]) {
              board[i][col] = { type: fenToPieceType[pieceType], color: isWhite ? 'w' : 'b' }
            }
          }
          col++
          if (col > 8) break
        }
      }
    }
    
    // Calculate row and col for the square with validation
    const row = 8 - parseInt(squareRank, 10)
    const col = squareFile.charCodeAt(0) - 97
    
    if (isNaN(row) || isNaN(col) || row < 0 || row > 7 || col < 0 || col > 7) {
      return
    }
    
    // Check if there's a piece on this square
    if (board[row][col]) {
      // Remove the piece
      board[row][col] = null
      
      // Convert board back to FEN
      let fenBoard = ''
      for (let i = 0; i < 8; i++) {
        let emptyCount = 0
        for (let j = 0; j < 8; j++) {
          const square = board[i][j]
          if (square === null) {
            emptyCount++
          } else {
            if (emptyCount > 0) {
              fenBoard += emptyCount
              emptyCount = 0
            }
            const pieceChar = pieceTypeToFEN[square.type] || 'p'
            fenBoard += square.color === 'w' ? pieceChar.toUpperCase() : pieceChar
          }
        }
        if (emptyCount > 0) {
          fenBoard += emptyCount
        }
        if (i < 7) fenBoard += '/'
      }
      
      // Preserve other FEN parts with defaults if missing
      // Preserve turn from current fen state to keep it independent
      const preservedTurn = fenParts[1] || DEFAULT_FEN_PARTS[1]
      const newFen = `${fenBoard} ${preservedTurn} ${fenParts[2] || DEFAULT_FEN_PARTS[2]} ${fenParts[3] || DEFAULT_FEN_PARTS[3]} ${fenParts[4] || DEFAULT_FEN_PARTS[4]} ${fenParts[5] || DEFAULT_FEN_PARTS[5]}`
      
      setFen(newFen)
      
      // Try to update game instance, but preserve turn if validation changes it
      try {
        const newGame = new Chess(newFen)
        const gameFen = newGame.fen().split(' ')
        if (gameFen[1] !== preservedTurn) {
          gameFen[1] = preservedTurn
          const correctedFen = gameFen.join(' ')
          try {
            const correctedGame = new Chess(correctedFen)
            setGame(correctedGame)
            setFen(correctedFen)
          } catch {
            setGame(newGame)
          }
        } else {
          setGame(newGame)
        }
      } catch (error) {
        // Keep old game instance if FEN is invalid (e.g., multiple kings)
        // The FEN is already set for display with preserved turn
      }
    }
  }
  
  // Handle drag start from piece palette
  const handlePieceDragStart = (e, piece) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify(piece))
    setDraggedPiece(piece)
    
    // Create a custom transparent drag image using SVG from Wikimedia Commons
    const dragImage = document.createElement('div')
    dragImage.style.position = 'absolute'
    dragImage.style.top = '-1000px'
    dragImage.style.left = '-1000px'
    dragImage.style.opacity = '0.7'
    dragImage.style.pointerEvents = 'none'
    dragImage.style.background = 'transparent'
    dragImage.style.border = 'none'
    dragImage.style.padding = '0'
    dragImage.style.margin = '0'
    dragImage.style.width = '56px'
    dragImage.style.height = '56px'
    dragImage.style.display = 'flex'
    dragImage.style.alignItems = 'center'
    dragImage.style.justifyContent = 'center'
    
    // Create inline SVG matching PieceIcon component
    const isWhite = piece.color === 'w'
    const fill = isWhite ? '#ffffff' : '#000000'
    const stroke = isWhite ? '#000000' : '#ffffff'
    const strokeWidth = '1.2'
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '56')
    svg.setAttribute('height', '56')
    svg.setAttribute('viewBox', '0 0 45 45')
    svg.style.display = 'block'
    svg.style.opacity = '0.8'
    
    // Use fenType if available (for palette pieces), otherwise use type
    const pieceType = (piece.fenType || piece.type).toLowerCase()
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('fill', fill)
    g.setAttribute('stroke', stroke)
    g.setAttribute('stroke-width', strokeWidth)
    
    let path
    switch (pieceType) {
      case 'p':
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', 'M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z')
        path.setAttribute('stroke-linecap', 'round')
        path.setAttribute('stroke-linejoin', 'round')
        g.appendChild(path)
        break
      case 'r':
        const rookPaths = [
          { d: 'M9 39h27v-3H9v3zM12 36v-4h21v4H12zM11 14V9h4v2h5V9h5v2h5V9h4v5', strokeLinecap: 'butt' },
          { d: 'M34 14l-3 3H14l-3-3' },
          { d: 'M31 17v12.5H14V17', strokeLinecap: 'butt', strokeLinejoin: 'miter' },
          { d: 'M31 29.5l1.5 2.5h-20l1.5-2.5' }
        ]
        rookPaths.forEach(p => {
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', p.d)
          if (p.strokeLinecap) path.setAttribute('stroke-linecap', p.strokeLinecap)
          if (p.strokeLinejoin) path.setAttribute('stroke-linejoin', p.strokeLinejoin)
          g.appendChild(path)
        })
        break
      case 'n':
        const knightPaths = [
          { d: 'M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18', fill: fill, stroke: stroke },
          { d: 'M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10', fill: fill, stroke: stroke },
          { d: 'M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z', fill: isWhite ? '#000' : '#fff', stroke: isWhite ? '#000' : '#fff' },
          { d: 'M 15 15.5 A 0.5 1.5 0 1 1  14,15.5 A 0.5 1.5 0 1 1  15 15.5 z', transform: 'matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)', fill: isWhite ? '#000' : '#fff', stroke: isWhite ? '#000' : '#fff' }
        ]
        g.setAttribute('stroke-linecap', 'round')
        g.setAttribute('stroke-linejoin', 'round')
        knightPaths.forEach(p => {
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', p.d)
          if (p.fill) path.setAttribute('fill', p.fill)
          if (p.stroke) path.setAttribute('stroke', p.stroke)
          if (p.transform) path.setAttribute('transform', p.transform)
          g.appendChild(path)
        })
        break
      case 'b':
        const bishopMainGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        bishopMainGroup.setAttribute('stroke-linecap', 'butt')
        const bishopMainPaths = [
          { d: 'M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z' },
          { d: 'M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z' },
          { d: 'M 25 8 A 2.5 2.5 0 1 1  20,8 A 2.5 2.5 0 1 1  25 8 z' }
        ]
        bishopMainPaths.forEach(p => {
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', p.d)
          bishopMainGroup.appendChild(path)
        })
        g.appendChild(bishopMainGroup)
        
        const detailStroke = isWhite ? '#000' : '#fff'
        const bishopDetailPaths = [
          { d: 'M 17.5,26 L 27.5,26', strokeLinejoin: 'miter' },
          { d: 'M 15,30 L 30,30', strokeLinejoin: 'miter' },
          { d: 'M 22.5,15.5 L 22.5,20.5', strokeLinejoin: 'miter' },
          { d: 'M 20,18 L 25,18', strokeLinejoin: 'miter' }
        ]
        bishopDetailPaths.forEach(p => {
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', p.d)
          path.setAttribute('fill', 'none')
          path.setAttribute('stroke', detailStroke)
          path.setAttribute('stroke-width', strokeWidth)
          if (p.strokeLinejoin) path.setAttribute('stroke-linejoin', p.strokeLinejoin)
          g.appendChild(path)
        })
        break
      case 'q':
        const detailStrokeQ = isWhite ? '#000' : '#fff'
        const queenPaths = [
          { d: 'M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z', fill: fill, stroke: stroke },
          { d: 'M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z', fill: fill, stroke: stroke },
          { d: 'M 11.5,30 C 15,29 30,29 33.5,30', fill: 'none', stroke: detailStrokeQ },
          { d: 'M 12,33.5 C 18,32.5 27,32.5 33,33.5', fill: 'none', stroke: detailStrokeQ },
          { type: 'circle', cx: '6', cy: '12', r: '2', fill: fill, stroke: stroke },
          { type: 'circle', cx: '14', cy: '9', r: '2', fill: fill, stroke: stroke },
          { type: 'circle', cx: '22.5', cy: '8', r: '2', fill: fill, stroke: stroke },
          { type: 'circle', cx: '31', cy: '9', r: '2', fill: fill, stroke: stroke },
          { type: 'circle', cx: '39', cy: '12', r: '2', fill: fill, stroke: stroke }
        ]
        queenPaths.forEach(p => {
          if (p.type === 'circle') {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
            circle.setAttribute('cx', p.cx)
            circle.setAttribute('cy', p.cy)
            circle.setAttribute('r', p.r)
            if (p.fill) circle.setAttribute('fill', p.fill)
            if (p.stroke) circle.setAttribute('stroke', p.stroke)
            g.appendChild(circle)
          } else {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
            path.setAttribute('d', p.d)
            if (p.fill) path.setAttribute('fill', p.fill)
            if (p.stroke) path.setAttribute('stroke', p.stroke)
            if (p.fill === 'none') path.setAttribute('fill', 'none')
            g.appendChild(path)
          }
        })
        break
      case 'k':
        const kingPaths = [
          { d: 'M22.5 11.63V6M20 8h5', strokeLinejoin: 'miter' },
          { d: 'M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5', strokeLinecap: 'butt', strokeLinejoin: 'miter' },
          { d: 'M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z' },
          { d: 'M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0' }
        ]
        kingPaths.forEach(p => {
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', p.d)
          path.setAttribute('stroke', stroke)
          if (p.strokeLinecap) path.setAttribute('stroke-linecap', p.strokeLinecap)
          if (p.strokeLinejoin) path.setAttribute('stroke-linejoin', p.strokeLinejoin)
          g.appendChild(path)
        })
        break
    }
    
    svg.appendChild(g)
    dragImage.appendChild(svg)
    // Append to DOM first
    document.body.appendChild(dragImage)
    
    // Make element temporarily visible and positioned for setDragImage (browsers require this)
    dragImage.style.position = 'fixed'
    dragImage.style.top = '0px'
    dragImage.style.left = '0px'
    dragImage.style.opacity = '0.8'
    dragImage.style.zIndex = '99999'
    dragImage.style.pointerEvents = 'none'
    
    // Force multiple reflows to ensure element is fully rendered and visible
    void dragImage.offsetWidth
    void dragImage.offsetHeight
    const rect = dragImage.getBoundingClientRect()
    void rect.width
    void rect.height
    
    // Set drag image - this MUST happen while element is visible
    e.dataTransfer.setDragImage(dragImage, 28, 28)
    
    // Hide it after setDragImage (browser has already captured it)
    dragImage.style.top = '-1000px'
    dragImage.style.left = '-1000px'
    dragImage.style.position = 'absolute'
    
    // Clean up after a short delay (store timeout ID for cleanup)
    dragImageTimeoutRef.current = setTimeout(() => {
      if (document.body.contains(dragImage)) {
        document.body.removeChild(dragImage)
      }
      dragImageTimeoutRef.current = null
    }, 0)
  }
  
  // Handle drag end
  const handlePieceDragEnd = (e) => {
    setDraggedPiece(null)
    // Restore visibility of any hidden dragged elements
    if (e && e.currentTarget) {
      e.currentTarget.style.visibility = ''
    }
  }
  
  // Enhanced onDrop to handle both board moves and palette drops
  const enhancedOnDrop = (sourceSquare, targetSquare) => {
    // If we have a dragged piece from palette, place it
    if (draggedPiece && !sourceSquare) {
      // Validate target square notation format
      if (!targetSquare || targetSquare.length !== 2) {
        setDraggedPiece(null)
        return false
      }
      
      const targetFile = targetSquare[0]
      const targetRank = targetSquare[1]
      
      if (targetFile < 'a' || targetFile > 'h' || targetRank < '1' || targetRank > '8') {
        setDraggedPiece(null)
        return false
      }
      
      setDraggedPiece(null)
      
      // Parse FEN directly to avoid Chess.js validation issues
      if (!fen || typeof fen !== 'string') {
        return false
      }
      
      const fenParts = fen.split(' ')
      if (fenParts.length < 6 || !fenParts[0]) {
        return false
      }
      
      const boardPart = fenParts[0]
      const ranks = boardPart.split('/')
      
      if (ranks.length !== 8) {
        return false
      }
      
      // Convert ranks to 2D array
      const board = Array(8).fill(null).map(() => Array(8).fill(null))
      for (let i = 0; i < 8; i++) {
        if (!ranks[i]) {
          continue // Skip missing rank
        }
        let col = 0
        for (let j = 0; j < ranks[i].length && col < 8; j++) {
          const char = ranks[i][j]
          if (char >= '1' && char <= '8') {
            const num = parseInt(char, 10)
            col += num
            if (col > 8) col = 8
          } else {
            if (col >= 0 && col < 8) {
              const isWhite = char >= 'A' && char <= 'Z'
              const pieceType = char.toLowerCase()
              if (fenToPieceType[pieceType]) {
                board[i][col] = { type: fenToPieceType[pieceType], color: isWhite ? 'w' : 'b' }
              }
            }
            col++
            if (col > 8) break
          }
        }
      }
      
      // Place the dragged piece with validation
      const row = 8 - parseInt(targetRank, 10)
      const col = targetFile.charCodeAt(0) - 97
      
      if (isNaN(row) || isNaN(col) || row < 0 || row > 7 || col < 0 || col > 7) {
        return false
      }
      
      board[row][col] = { type: draggedPiece.type, color: draggedPiece.color }
      
      // Update FEN directly
      let fenBoard = ''
      for (let i = 0; i < 8; i++) {
        let emptyCount = 0
        for (let j = 0; j < 8; j++) {
          const square = board[i][j]
          if (square === null) {
            emptyCount++
          } else {
            if (emptyCount > 0) {
              fenBoard += emptyCount
              emptyCount = 0
            }
            const pieceChar = pieceTypeToFEN[square.type] || 'p'
            fenBoard += square.color === 'w' ? pieceChar.toUpperCase() : pieceChar
          }
        }
        if (emptyCount > 0) {
          fenBoard += emptyCount
        }
        if (i < 7) fenBoard += '/'
      }
      
      // Preserve other FEN parts with defaults if missing
      // Preserve turn from current fen state to keep it independent
      const preservedTurn = fenParts[1] || DEFAULT_FEN_PARTS[1]
      const newFen = `${fenBoard} ${preservedTurn} ${fenParts[2] || DEFAULT_FEN_PARTS[2]} ${fenParts[3] || DEFAULT_FEN_PARTS[3]} ${fenParts[4] || DEFAULT_FEN_PARTS[4]} ${fenParts[5] || DEFAULT_FEN_PARTS[5]}`
      
      setFen(newFen)
      
      // Try to update game instance, but preserve turn if validation changes it
      try {
        const newGame = new Chess(newFen)
        const gameFen = newGame.fen().split(' ')
        if (gameFen[1] !== preservedTurn) {
          gameFen[1] = preservedTurn
          const correctedFen = gameFen.join(' ')
          try {
            const correctedGame = new Chess(correctedFen)
            setGame(correctedGame)
            setFen(correctedFen)
          } catch {
            setGame(newGame)
          }
        } else {
          setGame(newGame)
        }
      } catch (error) {
        // Keep old game instance if FEN is invalid (e.g., multiple kings)
        // The FEN is already set for display with preserved turn
      }
      
      return true
    }
    
    // Normal board piece movement
    if (sourceSquare) {
      return onDrop(sourceSquare, targetSquare)
    }
    
    return false
  }

  // Handle right-click to delete pieces


  // Remove default drag rectangle - intercept ALL dragstart events at the earliest possible moment
  useEffect(() => {
    const handleAllDragStart = (e) => {
      // Set transparent drag image for ALL drags immediately
      // This must happen before any other handlers
      if (transparentDragImageRef.current) {
        const canvas = transparentDragImageRef.current
        // Ensure canvas is visible when setDragImage is called
        const wasHidden = canvas.style.top === '-1000px'
        if (wasHidden) {
          canvas.style.position = 'fixed'
          canvas.style.top = '0'
          canvas.style.left = '0'
          void canvas.offsetWidth // Force reflow
        }
        e.dataTransfer.setDragImage(canvas, 0, 0)
        if (wasHidden) {
          canvas.style.top = '-1000px'
          canvas.style.left = '-1000px'
          canvas.style.position = 'absolute'
        }
      }
    }

    // Use capture phase at the document level to catch ALL dragstart events first
    document.addEventListener('dragstart', handleAllDragStart, { capture: true, passive: false })
    return () => {
      document.removeEventListener('dragstart', handleAllDragStart, { capture: true })
    }
  }, [])

  const updateFenFromBoard = (gameCopy, board) => {
    let fenBoard = ''
    for (let i = 0; i < 8; i++) {
      let emptyCount = 0
      for (let j = 0; j < 8; j++) {
        const square = board[i][j]
        if (square === null) {
          emptyCount++
        } else {
          if (emptyCount > 0) {
            fenBoard += emptyCount
            emptyCount = 0
          }
          const pieceChar = pieceTypeToFEN[square.type] || 'p'
          fenBoard += square.color === 'w' ? pieceChar.toUpperCase() : pieceChar
        }
      }
      if (emptyCount > 0) {
        fenBoard += emptyCount
      }
      if (i < 7) fenBoard += '/'
    }

    // Preserve turn from current fen state (not from gameCopy) to keep it independent
    const currentFenParts = fen.split(' ')
    const preservedTurn = currentFenParts[1] || DEFAULT_FEN_PARTS[1]
    const newFen = `${fenBoard} ${preservedTurn} ${currentFenParts[2] || DEFAULT_FEN_PARTS[2]} ${currentFenParts[3] || DEFAULT_FEN_PARTS[3]} ${currentFenParts[4] || DEFAULT_FEN_PARTS[4]} ${currentFenParts[5] || DEFAULT_FEN_PARTS[5]}`

    // Always update the FEN string first (react-chessboard can display any FEN)
    setFen(newFen)
    
    try {
      // Try to create a new Chess instance with the FEN for game logic
      const newGame = new Chess(newFen)
      // Ensure the turn is preserved (Chess.js might change it during validation)
      const gameFen = newGame.fen().split(' ')
      if (gameFen[1] !== preservedTurn) {
        gameFen[1] = preservedTurn
        const correctedFen = gameFen.join(' ')
        try {
          const correctedGame = new Chess(correctedFen)
          setGame(correctedGame)
          setFen(correctedFen)
        } catch {
          setGame(newGame)
        }
      } else {
        setGame(newGame)
      }
    } catch (error) {
      // If validation fails (e.g., multiple kings), create a minimal game instance
      // We'll keep the old game for basic functionality but use the new FEN for display
      // react-chessboard will display the FEN correctly even if Chess.js doesn't validate it
      try {
        // Create a new game and try to manually place pieces
        const tempGame = new Chess()
        tempGame.clear()
        
        // Try to place pieces - if it fails due to validation, that's okay
        // The FEN is already set for display purposes
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < 8; j++) {
            const square = board[i][j]
            if (square) {
              const file = String.fromCharCode(97 + j)
              const rank = 8 - i
              const squareName = `${file}${rank}`
              try {
                tempGame.put({ type: square.type, color: square.color }, squareName)
              } catch (putError) {
                // Ignore put errors (e.g., multiple kings) - FEN is already set
              }
            }
          }
        }
        setGame(tempGame)
      } catch (fallbackError) {
        // If all else fails, keep the old game but FEN is already updated for display
      }
    }
  }

  // Set turn directly from dropdown selection
  const handleTurnChange = (e) => {
    const newTurn = e.target.value // 'w' or 'b'
    if (!fen || typeof fen !== 'string') {
      return
    }
    
    const fenParts = fen.split(' ')
    if (fenParts.length < 2) {
      return
    }
    
    fenParts[1] = newTurn
    const newFen = fenParts.join(' ')
    
    try {
      const newGame = new Chess(newFen)
      setGame(newGame)
      setFen(newGame.fen())
    } catch (error) {
      // If Chess.js fails, update FEN directly
      setFen(newFen)
    }
  }

  const handleCastlingRightsChange = (right, enabled) => {
    // Validate FEN before parsing
    if (!fen || typeof fen !== 'string') {
      return
    }
    
    try {
      const gameCopy = new Chess(fen)
      const fenParts = gameCopy.fen().split(' ')
      if (fenParts.length < 6) {
        return
      }
      let castling = fenParts[2] || '-'
      
      if (enabled) {
        if (!castling.includes(right)) {
          castling += right
        }
      } else {
        castling = castling.replace(right, '')
      }
      
      if (castling === '') castling = '-'
      fenParts[2] = castling
      const newFen = fenParts.join(' ')
      
      try {
        const newGame = new Chess(newFen)
        setGame(newGame)
        setFen(newGame.fen())
      } catch (error) {
        // If Chess.js fails, update FEN directly
        setFen(newFen)
        if (import.meta.env.DEV) {
          console.error('Error updating castling rights:', error)
        }
      }
    } catch (error) {
      // Fallback: parse FEN directly
      const fenParts = fen.split(' ')
      if (fenParts.length >= 6) {
        let castling = fenParts[2] || '-'
        
        if (enabled) {
          if (!castling.includes(right)) {
            castling += right
          }
        } else {
          castling = castling.replace(right, '')
        }
        
        if (castling === '') castling = '-'
        fenParts[2] = castling
        const newFen = fenParts.join(' ')
        setFen(newFen)
      }
      if (import.meta.env.DEV) {
        console.error('Error updating castling rights:', error)
      }
    }
  }


  // Function to swap black and white pieces without changing board orientation
  // This only swaps piece colors, turn, and castling rights
  const swapPieceColors = (fenString) => {
    if (!fenString || typeof fenString !== 'string') {
      return fenString
    }
    
    const fenParts = fenString.split(' ')
    if (fenParts.length < 6) {
      return fenString
    }
    
    const boardPart = fenParts[0] || DEFAULT_FEN_PARTS[0]
    const turn = fenParts[1] || DEFAULT_FEN_PARTS[1]
    const castling = fenParts[2] || DEFAULT_FEN_PARTS[2]
    const enPassant = fenParts[3] || DEFAULT_FEN_PARTS[3]
    const halfmove = fenParts[4] || DEFAULT_FEN_PARTS[4]
    const fullmove = fenParts[5] || DEFAULT_FEN_PARTS[5]
    
    // Split board into ranks
    const ranks = boardPart.split('/')
    
    if (ranks.length !== 8) {
      return fenString // Invalid board, return original
    }
    
    // Swap piece colors in each rank (uppercase <-> lowercase)
    // Keep ranks in same order and files in same positions
    const swappedRanks = ranks.map(rank => {
      if (!rank) return rank
      let swappedRank = ''
      for (let i = 0; i < rank.length; i++) {
        const char = rank[i]
        if (char >= '1' && char <= '8') {
          // Keep numbers as is (empty squares)
          swappedRank += char
        } else if (char >= 'A' && char <= 'Z') {
          // White piece becomes black (uppercase to lowercase)
          swappedRank += char.toLowerCase()
        } else if (char >= 'a' && char <= 'z') {
          // Black piece becomes white (lowercase to uppercase)
          swappedRank += char.toUpperCase()
        }
      }
      return swappedRank
    })
    
    // Swap castling rights: K<->k, Q<->q
    let swappedCastling = ''
    if (castling === '-') {
      swappedCastling = '-'
    } else {
      if (castling.includes('K')) swappedCastling += 'k'
      if (castling.includes('Q')) swappedCastling += 'q'
      if (castling.includes('k')) swappedCastling += 'K'
      if (castling.includes('q')) swappedCastling += 'Q'
      if (swappedCastling === '') swappedCastling = '-'
    }
    
    // Keep turn the same - user controls turn separately via "Switch" button
    // Don't swap turn when swapping colors
    
    // Keep en passant the same (same square, but the capturing pawn color changes)
    // Keep halfmove and fullmove the same
    
    // Reconstruct FEN
    const swappedBoard = swappedRanks.join('/')
    return `${swappedBoard} ${turn} ${swappedCastling} ${enPassant} ${halfmove} ${fullmove}`
  }

  // Rotate FEN 180 degrees (flip board position)
  const rotateFEN180 = (fenString) => {
    if (!fenString || typeof fenString !== 'string') {
      return fenString
    }
    
    const fenParts = fenString.split(' ')
    if (fenParts.length < 6) {
      return fenString
    }
    
    const boardPart = fenParts[0] || DEFAULT_FEN_PARTS[0]
    const turn = fenParts[1] || DEFAULT_FEN_PARTS[1]
    const castling = fenParts[2] || DEFAULT_FEN_PARTS[2]
    const enPassant = fenParts[3] || DEFAULT_FEN_PARTS[3]
    const halfmove = fenParts[4] || DEFAULT_FEN_PARTS[4]
    const fullmove = fenParts[5] || DEFAULT_FEN_PARTS[5]
    
    // Split board into ranks (rank 8 to rank 1)
    const ranks = boardPart.split('/')
    
    if (ranks.length !== 8) {
      return fenString // Invalid board, return original
    }
    
    // Reverse the order of ranks (rank 8 becomes rank 1, rank 1 becomes rank 8)
    const reversedRanks = [...ranks].reverse()
    
    // Reverse each rank (files a-h become h-a, keeping piece colors the same)
    const rotatedRanks = reversedRanks.map(rank => {
      if (!rank) return rank
      // Reverse the string - keep pieces as-is (no color swap)
      return rank.split('').reverse().join('')
    })
    
    // Flip castling rights: K<->k, Q<->q
    let rotatedCastling = ''
    if (castling === '-') {
      rotatedCastling = '-'
    } else {
      if (castling.includes('K')) rotatedCastling += 'k'
      if (castling.includes('Q')) rotatedCastling += 'q'
      if (castling.includes('k')) rotatedCastling += 'K'
      if (castling.includes('q')) rotatedCastling += 'Q'
      if (rotatedCastling === '') rotatedCastling = '-'
    }
    
    // Flip en passant square: a3 -> h6, e3 -> d6, etc.
    let rotatedEnPassant = '-'
    if (enPassant && enPassant !== '-' && enPassant.length >= 2) {
      const file = enPassant[0]
      const rank = parseInt(enPassant[1], 10)
      if (file >= 'a' && file <= 'h' && !isNaN(rank) && rank >= 1 && rank <= 8) {
        const rotatedFile = String.fromCharCode(97 + (7 - (file.charCodeAt(0) - 97))) // a->h, b->g, etc.
        const rotatedRank = 9 - rank // 3->6, 6->3, etc.
        rotatedEnPassant = `${rotatedFile}${rotatedRank}`
      }
    }
    
    // Keep turn as-is
    // Reconstruct FEN - pieces are rotated 180 degrees, colors unchanged
    const rotatedBoard = rotatedRanks.join('/')
    return `${rotatedBoard} ${turn} ${rotatedCastling} ${rotatedEnPassant} ${halfmove} ${fullmove}`
  }

  const handleFlipBoard = () => {
    if (!fen || typeof fen !== 'string') {
      return
    }
    
    // Flip the FEN (rotate 180 degrees)
    const flippedFen = rotateFEN180(fen)
    
    if (!validateFENFormat(flippedFen)) {
      setProcessingError('Invalid FEN format after flip.')
      return
    }
    
    // Update FEN state
    setFen(flippedFen)
    
    // Reset visual flip state since FEN itself is now flipped
    setIsBoardFlipped(false)
    
    // Try to update game instance
    try {
      const newGame = new Chess(flippedFen)
      setGame(newGame)
    } catch (error) {
      // If Chess.js fails, that's okay - FEN is already set for display
    }
  }

  const handleSwapColors = () => {
    // Swap piece colors without changing board orientation or turn
    // Get the turn from current fen state to preserve it
    const currentFenParts = fen.split(' ')
    const preservedTurn = currentFenParts[1] || DEFAULT_FEN_PARTS[1]
    
    const swappedFen = swapPieceColors(fen)
    const swappedFenParts = swappedFen.split(' ')
    
    // Ensure turn is preserved (swapPieceColors should already preserve it, but double-check)
    const fenWithPreservedTurn = `${swappedFenParts[0]} ${preservedTurn} ${swappedFenParts[2]} ${swappedFenParts[3]} ${swappedFenParts[4]} ${swappedFenParts[5]}`
    
    // Set FEN first (this is what gets displayed)
    setFen(fenWithPreservedTurn)
    
    // Try to create Chess instance, but always preserve the turn
    try {
      const newGame = new Chess(fenWithPreservedTurn)
      const gameFen = newGame.fen().split(' ')
      
      // Force the turn to match what we want, regardless of what Chess.js says
      if (gameFen[1] !== preservedTurn) {
        gameFen[1] = preservedTurn
        const correctedFen = gameFen.join(' ')
        // Try to create corrected game, but if it fails, we'll just use the FEN string
        try {
          const correctedGame = new Chess(correctedFen)
          setGame(correctedGame)
          // Make sure FEN matches what we set
          setFen(correctedFen)
        } catch {
          // If corrected FEN is invalid, keep the original but don't update game
          // FEN is already set correctly above
        }
      } else {
        setGame(newGame)
      }
    } catch (error) {
      // If Chess.js validation fails completely, just keep the FEN
      // The FEN is already set with the correct turn
    }
  }

  // Component to render piece icons using clean inline SVG
  const PieceIcon = ({ piece, size = '3xl' }) => {
    const sizeMap = {
      '2xl': 40,
      '3xl': 56,
      '4xl': 72
    }
    const iconSize = sizeMap[size] || 56
    
    const isWhite = piece.color === 'w'
    const fill = isWhite ? '#ffffff' : '#000000'
    const stroke = isWhite ? '#000000' : '#ffffff'
    const strokeWidth = '1.2'
    
    // Convert piece type to FEN character for icon rendering
    // Handle both FEN characters ('k') and full names ('king')
    let pieceType = piece.type.toLowerCase()
    if (piece.fenType) {
      pieceType = piece.fenType.toLowerCase()
    } else if (pieceTypeToFEN[pieceType]) {
      // If it's a full name, convert to FEN character
      pieceType = pieceTypeToFEN[pieceType]
    }
    
    // Clean, simple SVG paths without artifacts
    const renderPiece = () => {
      switch (pieceType) {
        case 'p':
          return (
            <path 
              d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z" 
              fill={fill} 
              stroke={stroke} 
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )
        case 'r':
          return (
            <g fill={fill} stroke={stroke} strokeWidth={strokeWidth}>
              <path d="M9 39h27v-3H9v3zM12 36v-4h21v4H12zM11 14V9h4v2h5V9h5v2h5V9h4v5" strokeLinecap="butt"/>
              <path d="M34 14l-3 3H14l-3-3"/>
              <path d="M31 17v12.5H14V17" strokeLinecap="butt" strokeLinejoin="miter"/>
              <path d="M31 29.5l1.5 2.5h-20l1.5-2.5"/>
            </g>
          )
        case 'n':
          return (
            <g fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
              <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" fill={fill} stroke={stroke}/>
              <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" fill={fill} stroke={stroke}/>
              <path d="M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z" fill={isWhite ? '#000' : '#fff'} stroke={isWhite ? '#000' : '#fff'}/>
              <path d="M 15 15.5 A 0.5 1.5 0 1 1  14,15.5 A 0.5 1.5 0 1 1  15 15.5 z" transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)" fill={isWhite ? '#000' : '#fff'} stroke={isWhite ? '#000' : '#fff'}/>
            </g>
          )
        case 'b':
          const detailStrokeB = isWhite ? '#000' : '#fff'
          return (
            <g fill={fill} stroke={stroke} strokeWidth={strokeWidth}>
              <g fill={fill} stroke={stroke} strokeLinecap="butt">
                <path d="M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z"/>
                <path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z"/>
                <path d="M 25 8 A 2.5 2.5 0 1 1  20,8 A 2.5 2.5 0 1 1  25 8 z"/>
              </g>
              <path d="M 17.5,26 L 27.5,26" fill="none" stroke={detailStrokeB} strokeWidth={strokeWidth} strokeLinejoin="miter"/>
              <path d="M 15,30 L 30,30" fill="none" stroke={detailStrokeB} strokeWidth={strokeWidth} strokeLinejoin="miter"/>
              <path d="M 22.5,15.5 L 22.5,20.5" fill="none" stroke={detailStrokeB} strokeWidth={strokeWidth} strokeLinejoin="miter"/>
              <path d="M 20,18 L 25,18" fill="none" stroke={detailStrokeB} strokeWidth={strokeWidth} strokeLinejoin="miter"/>
            </g>
          )
        case 'q':
          const detailStrokeQ = isWhite ? '#000' : '#fff'
          return (
            <g fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round">
              <path d="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z" fill={fill} stroke={stroke}/>
              <path d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z" fill={fill} stroke={stroke}/>
              <path d="M 11.5,30 C 15,29 30,29 33.5,30" fill="none" stroke={detailStrokeQ} strokeWidth={strokeWidth}/>
              <path d="M 12,33.5 C 18,32.5 27,32.5 33,33.5" fill="none" stroke={detailStrokeQ} strokeWidth={strokeWidth}/>
              <circle cx="6" cy="12" r="2" fill={fill} stroke={stroke}/>
              <circle cx="14" cy="9" r="2" fill={fill} stroke={stroke}/>
              <circle cx="22.5" cy="8" r="2" fill={fill} stroke={stroke}/>
              <circle cx="31" cy="9" r="2" fill={fill} stroke={stroke}/>
              <circle cx="39" cy="12" r="2" fill={fill} stroke={stroke}/>
            </g>
          )
        case 'k':
          return (
            <g fill={fill} stroke={stroke} strokeWidth={strokeWidth}>
              <path d="M22.5 11.63V6M20 8h5" strokeLinejoin="miter"/>
              <path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill={fill} strokeLinecap="butt" strokeLinejoin="miter"/>
              <path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z" fill={fill}/>
              <path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" stroke={stroke}/>
            </g>
          )
        default:
          return null
      }
    }
    
    const renderedPiece = renderPiece()
    
    return (
      <svg 
        width={iconSize} 
        height={iconSize} 
        viewBox="0 0 45 45"
        style={{ display: 'block' }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {renderedPiece}
      </svg>
    )
  }

  // Validate FEN format to prevent URL injection and open redirects
  const validateFENFormat = (fenString) => {
    if (!fenString || typeof fenString !== 'string') {
      return false
    }
    
    // FEN format: board (8 ranks separated by /) + 6 additional fields
    // Example: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
    const parts = fenString.trim().split(/\s+/)
    
    if (parts.length !== 6) {
      return false
    }
    
    // Validate board part (first part)
    const board = parts[0]
    const ranks = board.split('/')
    
    if (ranks.length !== 8) {
      return false
    }
    
    // Each rank should only contain valid FEN characters
    const validFENChars = /^[rnbqkpRNBQKP1-8]+$/
    for (const rank of ranks) {
      if (!validFENChars.test(rank)) {
        return false
      }
      // Count squares in rank (should sum to 8)
      let squareCount = 0
      for (const char of rank) {
        if (char >= '1' && char <= '8') {
          squareCount += parseInt(char, 10)
        } else {
          squareCount++
        }
      }
      if (squareCount !== 8) {
        return false
      }
    }
    
    // Validate turn (should be 'w' or 'b')
    if (parts[1] !== 'w' && parts[1] !== 'b') {
      return false
    }
    
    // Validate castling (should be '-' or contain only KQkq)
    if (parts[2] !== '-' && !/^[KQkq]*$/.test(parts[2])) {
      return false
    }
    
    // Validate en passant (should be '-' or a valid square like e3, a6, etc.)
    if (parts[3] !== '-' && !/^[a-h][36]$/.test(parts[3])) {
      return false
    }
    
    // Validate halfmove and fullmove (should be numbers)
    if (!/^\d+$/.test(parts[4]) || !/^\d+$/.test(parts[5])) {
      return false
    }
    
    return true
  }

  // Check for invalid king counts (multiple kings on same side or missing kings)
  const checkKingCounts = () => {
    const fenParts = fen.split(' ')
    const boardPart = fenParts[0]
    
    // Count kings for each side
    let whiteKings = 0
    let blackKings = 0
    
    for (let i = 0; i < boardPart.length; i++) {
      const char = boardPart[i]
      if (char === 'K') whiteKings++
      if (char === 'k') blackKings++
    }
    
    const warnings = []
    if (whiteKings === 0) {
      warnings.push('White is missing a king')
    } else if (whiteKings > 1) {
      warnings.push(`White has ${whiteKings} kings (should be 1)`)
    }
    
    if (blackKings === 0) {
      warnings.push('Black is missing a king')
    } else if (blackKings > 1) {
      warnings.push(`Black has ${blackKings} kings (should be 1)`)
    }
    
    return warnings
  }

  const handleAnalyzeLichess = () => {
    if (!validateFENFormat(fen)) {
      setProcessingError('Invalid FEN format. Cannot open analysis.')
      return
    }
    
    const warnings = checkKingCounts()
    if (warnings.length > 0) {
      const warningMessage = 'Warning: Invalid king count detected!\n\n' + warnings.join('\n') + '\n\nDo you still want to analyze this position?'
      if (!window.confirm(warningMessage)) {
        return
      }
    }
    
    // Send FEN as-is (from white's perspective), same as Chess.com
    // Board orientation is only a visual display setting, not part of the FEN
    const fenToAnalyze = fen
    
    const lichessFEN = fenToAnalyze.replace(/ /g, '_').replace(/[^rnbqkpRNBQKP0-9\/_wbKQkq-]/g, '')
    if (lichessFEN.length > 200) {
      setProcessingError('FEN string too long for analysis.')
      return
    }
    
    window.open(`https://lichess.org/analysis/${lichessFEN}`, '_blank', 'noopener,noreferrer')
  }

  const handleAnalyzeChessCom = () => {
    // Validate FEN format before opening URL to prevent open redirect attacks
    if (!validateFENFormat(fen)) {
      setProcessingError('Invalid FEN format. Cannot open analysis.')
      return
    }
    
    const warnings = checkKingCounts()
    
    if (warnings.length > 0) {
      const warningMessage = 'Warning: Invalid king count detected!\n\n' + warnings.join('\n') + '\n\nDo you still want to analyze this position?'
      if (!window.confirm(warningMessage)) {
        return // User cancelled
      }
    }
    
    // Always send FEN as-is (from white's perspective), regardless of board orientation
    // Board orientation is only a visual display setting, not part of the FEN
    const fenToAnalyze = fen
    
    // Encode FEN for URL query parameter (encodeURIComponent prevents injection)
    const encodedFEN = encodeURIComponent(fenToAnalyze)
    window.open(`https://www.chess.com/analysis?fen=${encodedFEN}`, '_blank', 'noopener,noreferrer')
  }

  const handleEditorLichess = () => {
    // Validate FEN format before opening URL to prevent open redirect attacks
    if (!validateFENFormat(fen)) {
      setProcessingError('Invalid FEN format. Cannot open editor.')
      return
    }
    
    const warnings = checkKingCounts()
    
    if (warnings.length > 0) {
      const warningMessage = 'Warning: Invalid king count detected!\n\n' + warnings.join('\n') + '\n\nDo you still want to open this position?'
      if (!window.confirm(warningMessage)) {
        return // User cancelled
      }
    }
    
    // Send FEN as-is (from white's perspective), same as Chess.com
    const fenToAnalyze = fen
    
    // Encode FEN for URL - Lichess editor uses FEN in the path
    const lichessFEN = fenToAnalyze.replace(/ /g, '_').replace(/[^rnbqkpRNBQKP0-9\/_wbKQkq-]/g, '')
    if (lichessFEN.length > 200) {
      setProcessingError('FEN string too long for editor.')
      return
    }
    
    window.open(`https://lichess.org/editor/${lichessFEN}`, '_blank', 'noopener,noreferrer')
  }

  const handleEditFENTool = () => {
    // Validate FEN format before opening URL
    if (!validateFENFormat(fen)) {
      setProcessingError('Invalid FEN format. Cannot open FEN Tool.')
      return
    }
    
    // Encode FEN for URL query parameter
    const encodedFEN = encodeURIComponent(fen)
    window.open(`https://mutsuntsai.github.io/fen-tool/?fen=${encodedFEN}`, '_blank', 'noopener,noreferrer')
  }


  // Memoize castling rights to avoid recalculating on every render
  const castlingRights = useMemo(() => {
    if (!fen || typeof fen !== 'string') {
      return {
        whiteKingside: false,
        whiteQueenside: false,
        blackKingside: false,
        blackQueenside: false,
      }
    }
    
    const fenParts = fen.split(' ')
    const castling = (fenParts.length >= 3 && fenParts[2]) ? fenParts[2] : '-'
    return {
      whiteKingside: castling.includes('K'),
      whiteQueenside: castling.includes('Q'),
      blackKingside: castling.includes('k'),
      blackQueenside: castling.includes('q'),
    }
  }, [fen])


  // Helper function to get piece symbol
  const getPieceSymbol = (color, type) => {
    return PIECE_SYMBOLS[color]?.[type] || ''
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      <div className="container mx-auto px-4 pt-8 pb-4">
        {/* Title Section - Top, Centered */}
        <header className="text-center mb-4">
          <h1 className="text-5xl font-extrabold bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 bg-clip-text text-transparent drop-shadow-2xl mb-1 tracking-tight">
            Chess Scan
          </h1>
          <p className="text-gray-400 mt-1 text-sm">
            Scan, edit, and analyze chess positions
          </p>
        </header>

        {/* Main Content - Centered */}
        <div className="flex flex-col items-center justify-center w-full mt-10">
          {/* Board Container - Centered independently with palette and sidebar */}
          <div className="relative w-full mb-4 flex justify-center">
            {/* Piece Palette - Left Side - Repositioned closer to board */}
            <div 
              ref={paletteRef}
              className="absolute lg:right-[calc(50%+280px+0.75rem)] right-0 lg:w-48 w-full max-w-[200px] lg:max-w-none lg:left-auto"
            >
              <div className="bg-gray-800 rounded-lg p-3 shadow-2xl sticky top-4">
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-gray-400 mb-2 text-center">White</p>
                    <div className="grid grid-cols-3 gap-2">
                      {PIECE_TYPES.map((type) => {
                        const pieceChar = type.toUpperCase()
                        // Keep FEN character for icon display, but store full name for placement
                        const piece = { type: fenToPieceType[type], color: 'w', pieceChar, fenType: type }
                        return (
                          <div
                            key={`w-${type}`}
                            draggable={true}
                            data-palette-piece="true"
                            onDragStart={(e) => {
                              // CRITICAL: Set transparent drag image FIRST, synchronously, before anything else
                              // This must happen before the browser creates the default drag image
                              if (transparentDragImageRef.current) {
                                // Temporarily show canvas at 0,0 for setDragImage
                                const canvas = transparentDragImageRef.current
                                canvas.style.position = 'fixed'
                                canvas.style.top = '0'
                                canvas.style.left = '0'
                                void canvas.offsetWidth // Force reflow
                                e.dataTransfer.setDragImage(canvas, 0, 0)
                                canvas.style.top = '-1000px'
                                canvas.style.left = '-1000px'
                                canvas.style.position = 'absolute'
                              }
                              
                              // Hide the dragged element to prevent browser from using it
                              const draggedEl = e.currentTarget
                              draggedEl.style.visibility = 'hidden'
                              
                              // Call handler which will set the ghost piece image (will override transparent)
                              handlePieceDragStart(e, piece)
                            }}
                            onDragEnd={handlePieceDragEnd}
                            className="w-full aspect-square flex items-center justify-center rounded-lg border-2 border-gray-600 bg-gray-700 hover:border-gray-400 hover:bg-gray-600 cursor-grab active:cursor-grabbing transition-all"
                            title={`White ${pieceChar}`}
                          >
                            <PieceIcon piece={piece} size="3xl" />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  
                  <div>
                    <p className="text-xs text-gray-400 mb-2 text-center">Black</p>
                    <div className="grid grid-cols-3 gap-2">
                      {PIECE_TYPES.map((type) => {
                        const pieceChar = type.toLowerCase()
                        // Keep FEN character for icon display, but store full name for placement
                        const piece = { type: fenToPieceType[type], color: 'b', pieceChar, fenType: type }
                        return (
                          <div
                            key={`b-${type}`}
                            draggable={true}
                            data-palette-piece="true"
                            onDragStart={(e) => {
                              // CRITICAL: Set transparent drag image FIRST, synchronously, before anything else
                              // This must happen before the browser creates the default drag image
                              if (transparentDragImageRef.current) {
                                // Temporarily show canvas at 0,0 for setDragImage
                                const canvas = transparentDragImageRef.current
                                canvas.style.position = 'fixed'
                                canvas.style.top = '0'
                                canvas.style.left = '0'
                                void canvas.offsetWidth // Force reflow
                                e.dataTransfer.setDragImage(canvas, 0, 0)
                                canvas.style.top = '-1000px'
                                canvas.style.left = '-1000px'
                                canvas.style.position = 'absolute'
                              }
                              
                              // Hide the dragged element to prevent browser from using it
                              const draggedEl = e.currentTarget
                              draggedEl.style.visibility = 'hidden'
                              
                              // Call handler which will set the ghost piece image (will override transparent)
                              handlePieceDragStart(e, piece)
                            }}
                            onDragEnd={handlePieceDragEnd}
                            className="w-full aspect-square flex items-center justify-center rounded-lg border-2 border-gray-600 bg-gray-700 hover:border-gray-400 hover:bg-gray-600 cursor-grab active:cursor-grabbing transition-all"
                            title={`Black ${pieceChar}`}
                          >
                            <PieceIcon piece={piece} size="3xl" />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
                
                </div>
              </div>

                {/* Chess Board - Center (independently centered) */}
                <div className="flex flex-col items-center justify-self-center">
                  <div className="bg-gray-800 rounded-lg p-4 shadow-2xl w-full max-w-2xl">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
              
              {processingError && (
                <div className="mb-4 p-3 bg-red-900/50 border border-red-600 rounded-lg">
                  <p className="text-red-300 text-sm text-center">{processingError}</p>
                </div>
              )}

              <div className="mb-3 flex flex-wrap justify-center gap-2">
                <button
                  onClick={handleScanBoard}
                  disabled={isProcessing}
                  className={`px-4 py-2 font-semibold rounded-md border-2 text-xs ${
                    isProcessing
                      ? 'bg-gray-600 border-gray-500 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 border-blue-500 hover:border-blue-400 text-white'
                  }`}
                >
                  {isProcessing ? 'Processing...' : 'Upload Image'}
                </button>
                <button
                  onClick={handleReset}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 border-2 border-gray-600 hover:border-gray-500 text-white font-semibold rounded-md text-xs"
                >
                  Reset
                </button>
                <button
                  onClick={handleClear}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 border-2 border-red-500 hover:border-red-400 text-white font-semibold rounded-md text-xs"
                >
                  Clear
                </button>
                <button
                  onClick={handleFlipBoard}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 border-2 border-indigo-500 hover:border-indigo-400 text-white font-semibold rounded-md text-xs"
                >
                  Flip Board
                </button>
                <button
                  onClick={handleSwapColors}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 border-2 border-cyan-500 hover:border-cyan-400 text-white font-semibold rounded-md text-xs"
                  title="Swap black and white pieces"
                >
                  Swap Colors
                </button>
              </div>
              
              <div className="flex flex-col items-center relative">
                  <div 
                    className="bg-gray-700 rounded-lg p-3 relative"
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (draggedPiece) {
                        const rect = e.currentTarget.getBoundingClientRect()
                        const boardPadding = 12 // p-3 = 12px
                        const boardSize = 500
                      const squareSize = boardSize / 8
                      
                      // Calculate relative position within the board
                      const x = e.clientX - rect.left - boardPadding
                      const y = e.clientY - rect.top - boardPadding
                      
                      // Clamp to board bounds
                      const clampedX = Math.max(0, Math.min(boardSize - 1, x))
                      const clampedY = Math.max(0, Math.min(boardSize - 1, y))
                      
                      // Calculate square coordinates (0-7)
                      const col = Math.floor(clampedX / squareSize)
                      const row = Math.floor(clampedY / squareSize)
                      
                      // Convert to square notation (a-h, 1-8)
                      // Calculate square notation (a-h, 1-8)
                      // Account for board flip
                      let file, rank
                      if (!isBoardFlipped) {
                        file = String.fromCharCode(97 + col) // a-h
                        rank = 8 - row // 1-8 from bottom
                      } else {
                        file = String.fromCharCode(97 + (7 - col)) // reversed
                        rank = row + 1 // reversed
                      }
                      
                      const targetSquare = `${file}${rank}`
                      
                      // Validate target square
                      if (!targetSquare || targetSquare.length !== 2) {
                        setDraggedPiece(null)
                        return
                      }
                      
                      const targetFile = targetSquare[0]
                      const targetRank = targetSquare[1]
                      
                      if (targetFile < 'a' || targetFile > 'h' || targetRank < '1' || targetRank > '8') {
                        setDraggedPiece(null)
                        return
                      }
                      
                      // Parse FEN directly to avoid Chess.js validation issues
                      if (!fen || typeof fen !== 'string') {
                        setDraggedPiece(null)
                        return
                      }
                      
                      const fenParts = fen.split(' ')
                      if (fenParts.length < 6 || !fenParts[0]) {
                        setDraggedPiece(null)
                        return
                      }
                      
                      const boardPart = fenParts[0]
                      const ranks = boardPart.split('/')
                      
                      if (ranks.length !== 8) {
                        setDraggedPiece(null)
                        return
                      }
                      
                      // Convert ranks to 2D array
                      const board = Array(8).fill(null).map(() => Array(8).fill(null))
                      for (let i = 0; i < 8; i++) {
                        if (!ranks[i]) {
                          continue // Skip missing rank
                        }
                        let col = 0
                        for (let j = 0; j < ranks[i].length && col < 8; j++) {
                          const char = ranks[i][j]
                          if (char >= '1' && char <= '8') {
                            const num = parseInt(char, 10)
                            col += num
                            if (col > 8) col = 8
                          } else {
                            if (col >= 0 && col < 8) {
                              const isWhite = char >= 'A' && char <= 'Z'
                              const pieceType = char.toLowerCase()
                              const pieceTypeMap = { 'p': 'pawn', 'r': 'rook', 'n': 'knight', 'b': 'bishop', 'q': 'queen', 'k': 'king' }
                              if (pieceTypeMap[pieceType]) {
                                board[i][col] = { type: pieceTypeMap[pieceType], color: isWhite ? 'w' : 'b' }
                              }
                            }
                            col++
                            if (col > 8) break
                          }
                        }
                      }
                      
                      // Place the dragged piece with validation
                      const boardRow = 8 - parseInt(targetRank, 10)
                      const boardCol = targetFile.charCodeAt(0) - 97
                      
                      if (isNaN(boardRow) || isNaN(boardCol) || boardRow < 0 || boardRow > 7 || boardCol < 0 || boardCol > 7) {
                        setDraggedPiece(null)
                        return
                      }
                      
                      board[boardRow][boardCol] = { type: draggedPiece.type, color: draggedPiece.color }
                      
                      // Update FEN directly
                      let fenBoard = ''
                      for (let i = 0; i < 8; i++) {
                        let emptyCount = 0
                        for (let j = 0; j < 8; j++) {
                          const square = board[i][j]
                          if (square === null) {
                            emptyCount++
                          } else {
                            if (emptyCount > 0) {
                              fenBoard += emptyCount
                              emptyCount = 0
                            }
                            const pieceChar = pieceTypeToFEN[square.type] || 'p'
                            fenBoard += square.color === 'w' ? pieceChar.toUpperCase() : pieceChar
                          }
                        }
                        if (emptyCount > 0) {
                          fenBoard += emptyCount
                        }
                        if (i < 7) fenBoard += '/'
                      }
                      
                      // Preserve other FEN parts with defaults if missing
                      // Preserve turn from current fen state to keep it independent
                      const preservedTurn = fenParts[1] || DEFAULT_FEN_PARTS[1]
                      const newFen = `${fenBoard} ${preservedTurn} ${fenParts[2] || DEFAULT_FEN_PARTS[2]} ${fenParts[3] || DEFAULT_FEN_PARTS[3]} ${fenParts[4] || DEFAULT_FEN_PARTS[4]} ${fenParts[5] || DEFAULT_FEN_PARTS[5]}`
                      
                      setFen(newFen)
                      
                      // Try to update game instance, but preserve turn if validation changes it
                      try {
                        const newGame = new Chess(newFen)
                        const gameFen = newGame.fen().split(' ')
                        if (gameFen[1] !== preservedTurn) {
                          gameFen[1] = preservedTurn
                          const correctedFen = gameFen.join(' ')
                          try {
                            const correctedGame = new Chess(correctedFen)
                            setGame(correctedGame)
                            setFen(correctedFen)
                          } catch {
                            setGame(newGame)
                          }
                        } else {
                          setGame(newGame)
                        }
                      } catch (error) {
                        // Keep old game instance if FEN is invalid (e.g., multiple kings)
                        // The FEN is already set for display with preserved turn
                      }
                      
                      setDraggedPiece(null)
                    }
                  }}
                >
                  <Chessboard
                    position={fen}
                    onPieceDrop={enhancedOnDrop}
                    onSquareRightClick={handleSquareRightClick}
                    boardOrientation={isBoardFlipped ? 'black' : 'white'}
                    boardWidth={500}
                    animationDuration={0}
                    customDarkSquareStyle={{ backgroundColor: '#769656' }}
                    customLightSquareStyle={{ backgroundColor: '#eeeed2' }}
                  />
                </div>
                <p className="text-sm text-gray-200 mt-2 text-center font-semibold">
                  💡 Drag pieces from the left onto the board. Right click to delete pieces.
                </p>
                </div>
                </div>
              </div>

            {/* Sidebar with FEN - Right Side (positioned absolutely, doesn't affect centering) */}
            <div className="absolute lg:left-[calc(50%+280px+0.75rem)] right-0 lg:w-64 w-full max-w-[240px] lg:max-w-none">
                <div className="bg-gray-800 rounded-lg p-4 shadow-2xl h-full">
              <h2 className="text-xl font-bold mb-3 text-blue-400">
                FEN String
              </h2>
              <div className="bg-gray-900 rounded-lg p-3 mb-3">
                <code className="text-sm text-gray-300 break-all select-all">
                  {fen}
                </code>
              </div>
              
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(fen)
                  } catch (error) {
                    if (import.meta.env.DEV) {
                      console.error('Failed to copy to clipboard:', error)
                    }
                    // Fallback: select text in a textarea and let user copy manually
                    const textarea = document.createElement('textarea')
                    textarea.value = fen
                    textarea.style.position = 'fixed'
                    textarea.style.left = '-9999px'
                    document.body.appendChild(textarea)
                    textarea.select()
                    try {
                      document.execCommand('copy')
                    } catch (fallbackError) {
                      // Silently fail - user can copy manually if needed
                    }
                    document.body.removeChild(textarea)
                  }
                }}
                className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg shadow-lg transition-all duration-200 transform hover:scale-105 active:scale-95"
              >
                Copy FEN
              </button>

              <div className="mt-6 pt-6 border-t border-gray-700">
                <h3 className="text-lg font-semibold mb-3 text-gray-300">
                  Board Controls
                </h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="text-gray-400 text-sm font-medium mb-2 block">
                      Turn:
                    </label>
                    <div className="flex gap-4 mt-1">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="turn"
                          value="w"
                          checked={(() => {
                            const fenParts = fen.split(' ')
                            return (fenParts[1] || 'w') === 'w'
                          })()}
                          onChange={handleTurnChange}
                          className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 focus:ring-blue-500 focus:ring-2"
                        />
                        <span className="text-xs text-gray-300">White</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="turn"
                          value="b"
                          checked={(() => {
                            const fenParts = fen.split(' ')
                            return (fenParts[1] || 'w') === 'b'
                          })()}
                          onChange={handleTurnChange}
                          className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 focus:ring-blue-500 focus:ring-2"
                        />
                        <span className="text-xs text-gray-300">Black</span>
                      </label>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-gray-300 mb-2">
                      Castling Rights
                    </h4>
                    <div className="space-y-3">
                      <div>
                        <span className="text-gray-400 text-sm font-medium">White:</span>
                        <div className="flex gap-3 mt-1">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={castlingRights.whiteKingside}
                              onChange={(e) =>
                                handleCastlingRightsChange('K', e.target.checked)
                              }
                              className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-300">0-0 (Kingside)</span>
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={castlingRights.whiteQueenside}
                              onChange={(e) =>
                                handleCastlingRightsChange('Q', e.target.checked)
                              }
                              className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-300">0-0-0 (Queenside)</span>
                          </label>
                        </div>
                      </div>
                      <div>
                        <span className="text-gray-400 text-sm font-medium">Black:</span>
                        <div className="flex gap-3 mt-1">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={castlingRights.blackKingside}
                              onChange={(e) =>
                                handleCastlingRightsChange('k', e.target.checked)
                              }
                              className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-300">0-0 (Kingside)</span>
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={castlingRights.blackQueenside}
                              onChange={(e) =>
                                handleCastlingRightsChange('q', e.target.checked)
                              }
                              className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-300">0-0-0 (Queenside)</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        </div>

        {/* Analysis Buttons */}
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <button
            onClick={handleAnalyzeChessCom}
            onAuxClick={(e) => {
              if (e.button === 1) { // Middle mouse button
                e.preventDefault()
                handleAnalyzeChessCom()
              }
            }}
            className="px-4 py-2 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white font-bold text-xs rounded-xl shadow-2xl border-2 border-purple-300/50 hover:border-purple-200 transition-all duration-300 active:scale-95 backdrop-blur-sm"
          >
            Analyze on Chess.com
          </button>
          <button
            onClick={handleAnalyzeLichess}
            onAuxClick={(e) => {
              if (e.button === 1) { // Middle mouse button
                e.preventDefault()
                handleAnalyzeLichess()
              }
            }}
            className="px-4 py-2 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white font-bold text-xs rounded-xl shadow-2xl border-2 border-purple-300/50 hover:border-purple-200 transition-all duration-300 active:scale-95 backdrop-blur-sm"
          >
            Analyze on Lichess
          </button>
          <button
            onClick={handleEditorLichess}
            onAuxClick={(e) => {
              if (e.button === 1) { // Middle mouse button
                e.preventDefault()
                handleEditorLichess()
              }
            }}
            className="px-4 py-2 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white font-bold text-xs rounded-xl shadow-2xl border-2 border-purple-300/50 hover:border-purple-200 transition-all duration-300 active:scale-95 backdrop-blur-sm"
          >
            Edit with Lichess
          </button>
          <button
            onClick={handleEditFENTool}
            onAuxClick={(e) => {
              if (e.button === 1) { // Middle mouse button
                e.preventDefault()
                handleEditFENTool()
              }
            }}
            className="px-4 py-2 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white font-bold text-xs rounded-xl shadow-2xl border-2 border-purple-300/50 hover:border-purple-200 transition-all duration-300 active:scale-95 backdrop-blur-sm"
          >
            Edit with FEN Tool
          </button>
        </div>
      </div>
      
      {/* Footer Banner */}
      <footer className="w-full border-t border-gray-800 mt-auto py-1.5 bg-gray-900">
        <div className="container mx-auto px-4 text-center">
          <p className="text-xs text-gray-500">
            Made by{' '}
            <a 
              href="https://www.linkedin.com/in/jackyang29/" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-300 transition-colors underline"
            >
              Jack Yang
            </a>
            {' · '}
            Open source on{' '}
            <a 
              href="https://github.com/jxckyang/Chess-Scan" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-300 transition-colors underline"
            >
              GitHub
            </a>
          </p>
        </div>
      </footer>
    </div>
  )
}

export default App
