fetch("http://localhost:5000/api/auth/login", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  credentials: "include", // important for sending/receiving cookies
  body: JSON.stringify({
    email: "abhishekchouhannk@gmail.com",
    password: "newSecurePassword123"
  })
})
.then(res => res.json())
.then(data => {
  console.log("Login response:", data);
})
.catch(err => {
  console.error("Login error:", err);
});
