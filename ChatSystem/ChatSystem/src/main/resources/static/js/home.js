// Create a XMLHttpRequest object
var xhr = new XMLHttpRequest();

// Define a function to handle the load event
xhr.onload = function() {
  console.log('Request completed');
};

// Define a function to handle the error event
xhr.onerror = function() {
  console.log('Request failed');
};

// Define a function to trigger the disconnect
function disconnect() {
  // Abort the XMLHttpRequest
  xhr.abort();
  // Send a message to the server
  xhr.send('Client disconnected');
}

// Open a GET request to some URL
xhr.open('GET', 'http://example.com');
// Send the request
xhr.send();

disconnect();