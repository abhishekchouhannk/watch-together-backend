const response = await fetch('http://localhost:5000/api/auth/register', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        email: 'otakuabhi2003@gmail.com',
        username: 'testuser2',
        password: 'SecurePass123!',
        confirmPassword: 'SecurePass123!'
    })
});

const data = await response.json();
console.log(data);