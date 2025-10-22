fetch("http://localhost:5000/api/auth/forgot-password", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ email: "abhishekchouhannk@gmail.com" })
})
.then(res => res.json())
.then(data => console.log(data))
.catch(err => console.error(err));
