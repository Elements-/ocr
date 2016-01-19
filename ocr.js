var PNG = require('node-png').PNG;
var fs = require('fs');
var moment = require('moment');
var mongo = require('mongo-handler')('mongodb://localhost:27017/OCR');

var png = new PNG({
  filterType: -1
});

var src = fs.createReadStream(process.argv[2]);

function getIndex(x, y) {
  return png.width * y + x;
}

var characterData = [];
setTimeout(function() {
  mongo.findDocuments('Characters', {}, function(docs) {
    characterData = docs;
    src.pipe(png);
  });
}, 100);

png.on('parsed', function() {
  var imageData = [];

  // Conversion to binary color (black / white)
  for(var y = 0; y < png.height; y++) {
    for(var x = 0; x < png.width; x++) {
      var rawIndex = getIndex(x, y) << 2;
      var greyscaleValue = Math.floor((png.data[rawIndex] + png.data[rawIndex+1] + png.data[rawIndex+2]) / 3);
      var binaryColor = (greyscaleValue > 128 ? 1 : 0);
      imageData[getIndex(x, y)] = binaryColor;
    }
  }

  // Line Detection
  var lines = [];
  for(var y = 0; y < png.height; y++) {
    var containsBlack = false;

    for(var x = 0; x < png.width; x++) {
      if(imageData[getIndex(x, y)] == 0) {
        containsBlack = true;
      }
    }

    if(containsBlack) {
      if(lines[lines.length-1] && lines[lines.length-1].end == y-1) {
        lines[lines.length-1].end = y;
      } else {
        lines.push({
          start: y,
          end: y
        });
      }
    }
  }

  // Character Detection
  var characters = [];
  for(i in lines) {
    for(var x = 0; x < png.width; x++) {
      var containsBlack = false;
      var line = lines[i];

      for(var y = line.start; y <= line.end; y++) {
        if(imageData[getIndex(x, y)] == 0) {
          containsBlack = true;
        }
      }

      if(containsBlack) {
        if(characters[characters.length-1] && characters[characters.length-1].endX == x-1) {
          characters[characters.length-1].endX = x;
        } else {
          characters.push({
            startX: x,
            endX: x,
            startY: line.start,
            endY: line.end
          });
        }
      }
    }
  }

  // Refine edges of characters to remove extra whitespace
  for(i in characters) {
    var character = characters[i];
    var minY = character.endY;
    var maxY = character.startY;

    for(var x = character.startX; x <= character.endX; x++) {
      for(var y = character.startY; y <= character.endY; y++) {
        if(imageData[getIndex(x, y)] == 0) {
          if(minY > y) {
            minY = y;
          }
          break;
        }
      }

      for(var y = character.endY; y >= character.startY; y--) {
        if(imageData[getIndex(x, y)] == 0) {
          if(maxY < y) {
            maxY = y;
          }
          break;
        }
      }
    }

    if(characters[i].startY < minY) {
      characters[i].startY = minY;
    }
    if(characters[i].endY > maxY) {
      characters[i].endY = maxY;
    }
  }

  // Extract vector information
  var characterVectors = [];
  for(i in characters) {
    var character = characters[i];
    var kernelX = Math.round((character.endX - character.startX) / 5);
    var kernelY = Math.round((character.endY - character.startY) / 5);
    var vectors = [];
    vectors[25] = 0;
    vectors[26] = 0;
    vectors[27] = (character.endX - character.startX) / (character.endY - character.startY);

    // Get kernel greyscale values (vectors 0-24)
    for(var y = character.startY; y <= character.endY-1; y += kernelY) {
      for(var x = character.startX; x <= character.endX-1; x += kernelX) {
        // anaylyze kernel block
        var kernelTotal = 0;
        for(var kY = y; kY < y+kernelY; kY++) {
          for(var kX = x; kX < x+kernelX; kX++) {
            var val = imageData[getIndex(kX, kY)];
            if(kY > character.startY + (kernelY * 2.5)) {
              vectors[25] += val / (kernelX * (kernelY*2.5));
            } else {
              vectors[26] += val / (kernelX * (kernelY*2.5));
            }
            if(kX < character.endX && kY < character.endY) kernelTotal += val;
          }
        }

        setColor(x, y, 0, 100, 255);

        var kernelRatio = kernelTotal / (kernelX*kernelY);
        var index = Math.floor((y-character.startY)/kernelY) * 5 + Math.floor((x-character.startX)/kernelX);
        vectors[index] = kernelRatio;
        //console.log(kernelRatio);
      }
    }
    //console.log(vectors);
    characterVectors.push(vectors);
  }
  console.log(characterVectors);

  // Draw boxes around characters
  for(i in characters) {
    var character = characters[i];

    for(var x = character.startX; x <= character.endX; x++) {
      setColor(x, character.startY, 255, 0, 0);
    }

    for(var x = character.startX; x <= character.endX; x++) {
      setColor(x, character.endY, 0, 0, 255);
    }

    for(var y = character.startY; y <= character.endY; y++) {
      setColor(character.endX, y, 0, 255, 0);
    }
  }

  // Compare data or add new learned data to db
  if(process.argv[5]) {
    var realText = process.argv[5];
    for(i in characterVectors) {
      if(realText[i]) {
        var charIndex = getCharIndex(realText[i]);
        if(charIndex == -1) {
          var doc = {
            character: realText[i],
            fonts: [
              {
                name: process.argv[4],
                vectors: characterVectors[i]
              }
            ]
          }

          console.log('Adding new character:', doc);
          mongo.insertDocument('Characters', doc);
        } else {
          characterData[charIndex].fonts.push({
            name: process.argv[4],
            vectors: characterVectors[i]
          });

          console.log('Adding font', process.argv[4], 'to', realText[i]);
          mongo.updateDocument('Characters', { character: realText[i] }, characterData[charIndex]);
        }
      }
    }
  } else {
    // or search the database and compare to learned data
    for(i in characterVectors) {
      var differences = [];
      for(index in characterData) {
        var doc = characterData[index];
        for(fontIndex in doc.fonts) {
          for(v in doc.fonts[fontIndex].vectors) {
            //console.log(doc.vectors[v], characterVectors[i][v]);
            var diff = Math.pow(doc.fonts[fontIndex].vectors[v]-characterVectors[i][v], 2);
            //console.log('vector #', v, diff);
            differences[index] = differences[index] + diff || diff;
          }
        }
      }
      //console.log(differences);
      var min = 0;
      for(diff in differences) {
        if(differences[min] > differences[diff]) {
          min = diff;
        }
      }
      console.log('Min difference for char', i, min, differences[min], characterData[min].character);
    }
  }

  png.pack().pipe(fs.createWriteStream(process.argv[3]));
});

function setColor(x, y, r, g, b) {
  var index = getIndex(x, y) << 2;
  png.data[index] = r;
  png.data[index+1] = g;
  png.data[index+2] = b;
}

function getCharIndex(character) {
  for(i in characterData) {
    if(characterData[i].character == character) return i;
  }
  return -1;
}
