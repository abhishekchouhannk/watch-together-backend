const token = "c3a73bc02283c7fcb7367bb70e35b65ecc13637df5e0f49ca663e469dc18045f"; // replace with actual token

fetch(`http://localhost:5000/api/auth/reset-password/${token}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    password: "newSecurePassword123"
  })
})
.then(res => res.json())
.then(data => console.log("Reset response:", data))
.catch(err => console.error("Reset error:", err));
