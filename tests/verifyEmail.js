const token = "c0c412defe3af18443755818cd437ae04dbcb1e0f38ebdd4960c0d5ae4a94b34"; // replace with actual token

fetch(`http://localhost:5000/api/auth/verify-email/${token}`, {
  method: "GET",
  headers: {
    "Content-Type": "application/json"
  }
})
.then(res => res.json())
.then(data => {
  console.log("Verification response:", data);
})
.catch(err => {
  console.error("Verification error:", err);
});
